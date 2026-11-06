/**
 * The device's command line: find a board, check its parts one by one, set it up, and run it
 * against a gateway — with every part that is not wired yet simulated.
 *
 *   pnpm device ports
 *   pnpm device probe --port /dev/cu.usbmodem101
 *   pnpm device run --gateway http://127.0.0.1:8787 --port /dev/cu.usbmodem101
 *
 * `pnpm device help` lists everything. docs/hardware.md walks through the bring-up.
 */
import { resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { CheckpointKind, type CheckpointKindValue, addressFromPublicKey, checkpointKindName, fromHex } from '@pinky/protocol';
import { PART_NAMES, type PartName } from './bridge/assemble';
import { BoardClient } from './bridge/client';
import { MockBoard } from './bridge/mock-board';
import { listSerialPorts, openSerialTransport } from './bridge/serial';
import { HttpGatewayLink, LinkError } from './link';
import { probeBoard } from './probe';
import { DeviceRunner } from './runner';
import { type DeviceSession, loadProvisioning, openDeviceSession } from './session';

const HELP = `pinky device — bring up and run a sensor device

  ports                              list serial ports (find your board)
  probe         --port <port>        ask every part on a board to do its job once
                [--photo out.jpg]      and save the camera frame it took
  provision-se  --port <port> --lock-forever
                                     one-time, IRREVERSIBLE setup of a blank ATECC608B
  anchor-setup  --port <port> --venue <ID>
                                     tell an anchor board which venue it stands for
  enroll        --gateway <url> --admin-token <token> --venues <ID,ID> [--label <text>]
                                     register this device with a gateway
  run           --gateway <url> [--interval <seconds>]
                                     take readings and checkpoints against a gateway

device options (enroll, run):
  --port <port|mock>         the device board; omit for a fully simulated device
  --anchor-port <port|mock>  a venue-anchor board plugged into this machine
  --sim <parts>              keep these simulated although the board has them
                             (${PART_NAMES.join(', ')})
  --photos <file|folder>     take seal photos from here (newest image) instead of a camera
  --min-rssi <dBm>           weakest BLE signal at which an anchor counts as in range
  --data <dir>               where keys and state are kept (default .data/device)

A <port> looks like /dev/cu.usbmodem101 (macOS), /dev/ttyACM0 (Linux) or COM5 (Windows);
"mock" is an in-memory board, for trying the commands with nothing attached.`;

type Flags = Record<string, string | true>;

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {};
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[arg.slice(2)] = next;
        i++;
      } else flags[arg.slice(2)] = true;
    } else if (!command) command = arg;
  }
  return { command, flags };
}

const text = (flags: Flags, name: string): string | undefined => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined);
function required(flags: Flags, name: string): string {
  const value = text(flags, name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

/** pnpm runs scripts from the package folder; paths the user typed are relative to where they were. */
const fromHere = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line: string) => console.log(`${stamp()}  ${line}`);

async function openBoard(port: string, role: 'device' | 'anchor' = 'device'): Promise<BoardClient> {
  const onLog = (line: string) => console.log(`          [board] ${line}`);
  const transport = port === 'mock' ? new MockBoard({ role }).transport : await openSerialTransport(port);
  const board = new BoardClient(transport, { onLog });
  await board.waitReady();
  return board;
}

async function ports(): Promise<void> {
  const found = await listSerialPorts();
  if (found.length === 0) return console.log('No serial ports found. Is the board plugged in with a data cable?');
  for (const port of found) {
    const maker = [port.manufacturer, port.vendorId && `${port.vendorId}:${port.productId}`].filter(Boolean).join(' ');
    console.log(`${port.path}${maker ? `   ${maker}` : ''}`);
  }
}

async function probe(flags: Flags): Promise<void> {
  const board = await openBoard(required(flags, 'port'), flags.anchor ? 'anchor' : 'device');
  try {
    const photo = text(flags, 'photo');
    const { info, rows } = await probeBoard(board, photo ? { savePhotoTo: fromHere(photo) } : {});
    console.log(`${info.board} — firmware ${info.fw}, role: ${info.role}\n`);
    const width = Math.max(...rows.map((row) => row.part.length));
    for (const row of rows) {
      const mark = row.ok === null ? '·' : row.ok ? '✔' : '✖';
      console.log(`  ${mark} ${row.part.padEnd(width)}  ${row.detail}`);
    }
    const failing = rows.filter((row) => row.ok === false).length;
    const absent = rows.filter((row) => row.ok === null).length;
    console.log(`\n${failing === 0 ? 'Everything that is wired works.' : `${failing} part(s) need attention.`}${absent ? ` ${absent} not detected: they stay simulated.` : ''}`);
    if (failing > 0) process.exitCode = 1;
  } finally {
    await board.close();
  }
}

async function provisionSecureElement(flags: Flags): Promise<void> {
  if (flags['lock-forever'] !== true) {
    throw new Error(
      'This writes and LOCKS the ATECC608B: its configuration and key can never be changed afterwards.\n' +
        'Run it once per chip, on purpose, by adding --lock-forever.',
    );
  }
  const board = await openBoard(required(flags, 'port'));
  try {
    const result = await board.request('se.provision', { confirm: 'LOCK-FOREVER' }, 30_000);
    console.log(`ATECC608B provisioned and locked.\n  serial      0x${result.serial}\n  public key  0x${result.pubkey}`);
  } finally {
    await board.close();
  }
}

async function anchorSetup(flags: Flags): Promise<void> {
  const board = await openBoard(required(flags, 'port'), 'anchor');
  try {
    const info = await board.info();
    if (info.role !== 'anchor') throw new Error('this board runs the device firmware; flash it with an anchor-* environment first');
    const { venue_id } = await board.request('anchor.configure', { venue_id: required(flags, 'venue') });
    const about = await board.request('anchor.info');
    const address = addressFromPublicKey(fromHex(`0x${about.pubkey}`, 64));
    console.log(`Anchor configured for venue ${venue_id}.\n  anchor address  ${address}\n\nRegister the venue at the gateway with this address as its "anchor".`);
  } finally {
    await board.close();
  }
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

const gatewayUrl = (flags: Flags) => (text(flags, 'gateway') ?? process.env.GATEWAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

async function openSession(flags: Flags, gateway: string): Promise<DeviceSession> {
  const dataDir = fromHere(text(flags, 'data') ?? '.data/device');
  const published = async () => {
    const config = await getJson(`${gateway}/v1/config`);
    return { registry: config.arkiv.registry, attestor: config.attestor, arkivChainId: config.arkiv.chainId };
  };
  const provisioning = await loadProvisioning(dataDir, published);
  const current = await published().catch(() => undefined);
  if (current && (current.registry !== provisioning.registry || current.attestor !== provisioning.attestor || current.arkivChainId !== provisioning.arkivChainId)) {
    throw new Error(
      `This device was provisioned for another gateway (registry ${provisioning.registry}).\n` +
        `It will not trust ${gateway}. Use a different --data directory for it, or delete ${dataDir}/provisioning.json to re-provision.`,
    );
  }
  const simulate = (text(flags, 'sim') ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  const unknown = simulate.filter((part) => !PART_NAMES.includes(part as PartName));
  if (unknown.length) throw new Error(`unknown part(s) in --sim: ${unknown.join(', ')} (known: ${PART_NAMES.join(', ')})`);
  const photos = text(flags, 'photos');
  const minRssi = text(flags, 'min-rssi');
  const session = await openDeviceSession({
    provisioning,
    dataDir,
    ...(text(flags, 'port') ? { port: text(flags, 'port')! } : {}),
    ...(text(flags, 'anchor-port') ? { anchorPort: text(flags, 'anchor-port')! } : {}),
    simulate: simulate as PartName[],
    ...(photos ? { photos: fromHere(photos) } : {}),
    ...(minRssi ? { minAnchorRssi: Number(minRssi) } : {}),
    log: say,
  });
  console.log(`\nDevice ${session.device.address}`);
  const width = Math.max(...session.parts.map((row) => row.part.length));
  for (const row of session.parts) console.log(`  ${row.part.padEnd(width)}  ${row.source === 'board' ? 'REAL (board)' : row.source}`);
  console.log('');
  return session;
}

async function enroll(flags: Flags): Promise<void> {
  const gateway = gatewayUrl(flags);
  const session = await openSession(flags, gateway);
  try {
    const record = await getJson(`${gateway}/v1/admin/devices`, {
      method: 'POST',
      headers: { authorization: `Bearer ${required(flags, 'admin-token')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        certBundle: await session.device.certificate(),
        venueIds: required(flags, 'venues').split(',').map((venue) => venue.trim()),
        label: text(flags, 'label') ?? 'device',
      }),
    });
    console.log(`Enrolled ${record.address ?? session.device.address}. Assign it to a lot at the gateway, then: pnpm device run`);
  } finally {
    await session.close();
  }
}

const KEYS: Record<string, CheckpointKindValue> = {
  '1': CheckpointKind.WAREHOUSE_IN,
  '2': CheckpointKind.WAREHOUSE_OUT,
  '3': CheckpointKind.DOCK_HANDOFF,
  '4': CheckpointKind.FINAL_DELIVERY,
};

async function run(flags: Flags): Promise<void> {
  const gateway = gatewayUrl(flags);
  const session = await openSession(flags, gateway);
  const { device, steer } = session;
  const runner = new DeviceRunner(device, new HttpGatewayLink(gateway));
  const intervalMs = Math.max(2, Number(text(flags, 'interval') ?? 10)) * 1000;
  let stopping = false;

  // One thing at a time: a reading and a checkpoint must not interleave their sequence numbers.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (label: string, job: () => Promise<void>) => {
    queue = queue.then(job).catch((error) => {
      const detail = error instanceof LinkError ? `${error.message} ${JSON.stringify(error.detail)}` : (error as Error).message;
      say(`${label} failed: ${detail}`);
    });
    return queue;
  };

  say(`gateway ${gateway}`);
  while (!device.profile && !stopping) {
    try {
      await runner.sync();
    } catch (error) {
      say(`cannot reach the gateway: ${(error as Error).message}`);
    }
    if (!device.profile) {
      say('not assigned to a lot yet — enrol this device (pnpm device enroll) and create a lot for it; checking again in 5 s');
      await new Promise((done) => setTimeout(done, 5_000));
    }
  }
  const profile = device.profile!;
  say(`lot ${profile.assetId}: ${profile.tempMinCenti / 100}–${profile.tempMaxCenti / 100} °C, ${profile.rhMinCenti / 100}–${profile.rhMaxCenti / 100} %RH`);
  const stopSigning = runner.startSigning();

  const reading = () =>
    enqueue('reading', async () => {
      await runner.reading();
      say(`reading #${device.seq} sent`);
    });

  const checkpoint = (kind: CheckpointKindValue) =>
    enqueue('checkpoint', async () => {
      say(`${checkpointKindName(kind)}: recording the seal, asking the venue anchor…`);
      const sent = await runner.checkpoint(kind);
      say(`checkpoint ${sent.checkpointId.slice(0, 12)}… sent — ${sent.status}: the handoff is NOT accepted until a decision arrives`);
      // Keep watching without blocking further readings.
      void (async () => {
        let last = sent.status;
        while (!stopping) {
          const now = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 30_000 }).catch(() => undefined);
          if (!now) continue;
          if (now.status !== 'PENDING') {
            say(`checkpoint ${sent.checkpointId.slice(0, 12)}… → ${now.status}${now.decision ? ` (${now.decision})` : ''}${now.reason ? `: ${now.reason}` : ''}`);
            return;
          }
          if (last !== 'PENDING') last = now.status;
          say(`checkpoint ${sent.checkpointId.slice(0, 12)}… still PENDING — no decision yet, nothing is accepted`);
        }
      })();
    });

  let simTemp = 450;
  let simSeal: 'intact' | 'broken' = 'intact';
  let simFix = true;
  steer.climate(simTemp, 4500);
  steer.position({ latDeg: Number(text(flags, 'lat') ?? 19.0761), lonDeg: Number(text(flags, 'lon') ?? 72.8778) });

  const timer = setInterval(reading, intervalMs);
  void reading();

  const quit = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await queue;
    await stopSigning();
    await session.close();
    process.exit(0);
  };

  console.log('keys:  r reading   1 warehouse in   2 warehouse out   3 dock handoff   4 final delivery   q quit');
  console.log('       simulated parts only:  + / - temperature   b break/mend the seal   g GPS fix on/off\n');
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (_text, key: { name?: string; sequence?: string; ctrl?: boolean }) => {
      const pressed = key.sequence ?? '';
      if (pressed === 'q' || (key.ctrl && key.name === 'c')) return void quit();
      if (pressed === 'r') return void reading();
      if (KEYS[pressed]) return void checkpoint(KEYS[pressed]!);
      if (pressed === '+' || pressed === '-') {
        simTemp += pressed === '+' ? 50 : -50;
        say(steer.climate(simTemp, 4500) ? `simulated temperature ${(simTemp / 100).toFixed(1)} °C` : 'the SHT31 is real — warm or cool the sensor itself');
      } else if (pressed === 'b') {
        simSeal = simSeal === 'intact' ? 'broken' : 'intact';
        say(steer.seal(simSeal) ? `simulated seal is now ${simSeal}` : 'the camera is real — point it at the seal you want it to see');
      } else if (pressed === 'g') {
        simFix = !simFix;
        const moved = steer.position(simFix ? { latDeg: Number(text(flags, 'lat') ?? 19.0761), lonDeg: Number(text(flags, 'lon') ?? 72.8778) } : null);
        say(moved ? `simulated GPS ${simFix ? 'has a fix' : 'lost its fix'}` : 'the GPS is real — it reports what it sees');
      }
    });
  }
  process.on('SIGINT', () => void quit());
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'ports':
      return ports();
    case 'probe':
      return probe(flags);
    case 'provision-se':
      return provisionSecureElement(flags);
    case 'anchor-setup':
      return anchorSetup(flags);
    case 'enroll':
      return enroll(flags);
    case 'run':
      return run(flags);
    default:
      console.log(HELP);
  }
}

main().catch((error) => {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
});
