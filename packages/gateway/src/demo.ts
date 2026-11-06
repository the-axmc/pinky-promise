/**
 * The whole system on this machine, with a device walking a lot through its journey.
 *
 *   pnpm demo                         scripted journey, fully simulated device
 *   pnpm demo --pause                 hold at the two moments worth showing on the buyer page:
 *                                     in custody (buy now) and frozen (see the freeze)
 *   pnpm demo --interactive           you drive the device from the keyboard
 *   pnpm demo --port /dev/cu.usb…     same, with the real parts of a board (rest simulated)
 *   pnpm demo --port mock             same, through the in-memory board (exercises the bridge)
 *
 * It starts the local stack on fixed ports, registers two venues, enrols the device, creates
 * the lot and its receipt token, then either plays the journey or hands you the keys. The stack
 * stays up afterwards so the buyer page (pnpm web) can be pointed at it; Ctrl-C stops it.
 *
 * Decisions come from the stand-in model unless ZG_ROUTER_URL / ZG_API_KEY / ZG_MODEL are set,
 * in which case the real 0G Compute Router decides while the chains stay local. The stand-in
 * cannot see: it knows the simulator's two seal pictures and escalates any other photo, so a
 * real camera needs the real model.
 */
import {
  type DeviceSession,
  DeviceRunner,
  HttpGatewayLink,
  PART_NAMES,
  type PartName,
  SimulatedAnchor,
  openDeviceSession,
  runInteractive,
} from '@pinky/device';
import { hederaDevChain } from '@pinky/devnet';
import {
  type Address,
  CheckpointKind,
  type CheckpointKindValue,
  LotState,
  addressFromPublicKey,
  checkpointKindName,
  decodeReading,
  fromHex,
  decodeAnchorAttestation,
  isInRange,
} from '@pinky/protocol';
import { atsTokenAbi, receiptMarketAbi } from '@pinky/protocol/hedera';
import { http, createPublicClient, createWalletClient, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type LocalStack, startLocalStack } from './local';

const ASSET = 'LOT-42';
const ORIGIN = { venueId: 'WH-MUM-01', name: 'Mumbai cold store', latDeg: 19.076, lonDeg: 72.8777 };
const DOCK = { venueId: 'DK-PNQ-02', name: 'Pune receiving dock', latDeg: 18.5204, lonDeg: 73.8567 };
const ROAD = { latDeg: 18.8, lonDeg: 73.3 };
const PORTS = { gateway: 8787, arkiv: 8645, arkivAnvil: 8646, hedera: 8745, zg: 8845 };
/** A cold-chain pharma pallet: 2–8 °C, 20–70 % relative humidity. */
const COLD_CHAIN = { tempMinCenti: 200, tempMaxCenti: 800, rhMinCenti: 2000, rhMaxCenti: 7000 };

type Where = 'origin' | 'road' | 'dock';
type Flags = Record<string, string | true>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      i++;
    } else flags[arg.slice(2)] = true;
  }
  return flags;
}
const text = (flags: Flags, name: string) =>
  typeof flags[name] === 'string' ? (flags[name] as string) : undefined;

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line = '') => console.log(line ? `${stamp()}  ${line}` : '');
const act = (title: string) => console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 76 - title.length))}`);
const stateName = (value: number) =>
  Object.entries(LotState).find(([, v]) => v === value)?.[0] ?? String(value);

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help)
    return console.log(
      'pnpm demo [--pause [seconds]] [--interactive] [--port <port|mock>] [--anchor-port <port|mock>] [--sim parts] [--photos dir] [--temp-range min:max] [--once] [--verbose]',
    );

  const zgEnv =
    process.env.ZG_ROUTER_URL && process.env.ZG_API_KEY && process.env.ZG_MODEL
      ? { baseUrl: process.env.ZG_ROUTER_URL, apiKey: process.env.ZG_API_KEY, model: process.env.ZG_MODEL }
      : undefined;

  say('starting the local stack: Arkiv node, Hedera (real ATS contracts), 0G stand-in, gateway…');
  const stack = await startLocalStack({
    port: PORTS.gateway,
    ports: { arkiv: PORTS.arkiv, arkivAnvil: PORTS.arkivAnvil, hedera: PORTS.hedera, zg: PORTS.zg },
    ...(zgEnv ? { zg: zgEnv } : {}),
    gateway: { retryBaseMs: 500, retryMaxMs: 2_000 },
    ...(flags.verbose
      ? {
          log: (event, detail) => console.log(`          · ${event} ${detail ? JSON.stringify(detail) : ''}`),
        }
      : {}),
  });

  let session: DeviceSession | undefined;
  const shutdown = async () => {
    await session?.close().catch(() => {});
    await stack.stop().catch(() => {});
  };

  try {
    console.log(`
  gateway API      ${stack.url}            (admin token: ${stack.adminToken})
  Arkiv RPC        ${stack.arkiv.rpcUrl}   chain ${stack.arkiv.chainId}
  Hedera RPC       ${stack.hedera.rpcUrl}   chain ${stack.hedera.chainId}   oracle ${stack.hedera.oracle}
  decisions        ${zgEnv ? `0G Compute Router, model ${zgEnv.model}` : 'stand-in model (recorded as "dev-mock", never as 0G)'}
`);

    // --- the device ---------------------------------------------------------------------------
    let where: Where = 'origin';
    let realAnchorInUse = false;
    const simulated = {
      origin: new SimulatedAnchor(`0x${'31'.repeat(32)}`),
      dock: new SimulatedAnchor(`0x${'32'.repeat(32)}`),
    };
    simulated.origin.setVenue(ORIGIN.venueId);
    simulated.dock.setVenue(DOCK.venueId);

    const simulate = (text(flags, 'sim') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const unknown = simulate.filter((part) => !PART_NAMES.includes(part as PartName));
    if (unknown.length)
      throw new Error(`unknown part(s) in --sim: ${unknown.join(', ')} (known: ${PART_NAMES.join(', ')})`);

    session = await openDeviceSession({
      provisioning: {
        registry: stack.registry,
        attestor: stack.publicConfig.attestor,
        arkivChainId: stack.arkiv.chainId,
      },
      ...(text(flags, 'port') ? { port: text(flags, 'port')! } : {}),
      ...(text(flags, 'anchor-port') ? { anchorPort: text(flags, 'anchor-port')! } : {}),
      simulate: simulate as PartName[],
      ...(text(flags, 'photos') ? { photos: text(flags, 'photos')! } : {}),
      // The real anchor, if there is one, is the origin warehouse's. On the road nothing answers.
      wrapAnchor: (real) => ({
        attest: async (request) => {
          if (where === 'road') return null;
          if (where === 'dock') return simulated.dock.attest(request);
          return realAnchorInUse && real ? real.attest(request) : simulated.origin.attest(request);
        },
      }),
      log: say,
    });
    const { device, steer } = session;

    console.log(`  device ${device.address}`);
    const width = Math.max(...session.parts.map((row) => row.part.length));
    for (const row of session.parts)
      console.log(`    ${row.part.padEnd(width)}  ${row.source === 'board' ? 'REAL (board)' : row.source}`);
    console.log('');

    // --- venues: the origin's anchor is the real one when a real one answers ----------------------
    let originVenueId = ORIGIN.venueId;
    let originAnchor: Address = simulated.origin.address;
    if (session.anchorBoard) {
      let about = await session.anchorBoard.request('anchor.info').catch(() => undefined);
      if (!about) {
        await session.anchorBoard.request('anchor.configure', { venue_id: ORIGIN.venueId });
        about = await session.anchorBoard.request('anchor.info');
        say(`anchor board had no venue yet: set it to ${about.venue_id}`);
      }
      originVenueId = about.venue_id;
      originAnchor = addressFromPublicKey(fromHex(`0x${about.pubkey}`, 64));
      realAnchorInUse = true;
      say(`origin venue ${originVenueId} uses the anchor board (${originAnchor})`);
    } else if (session.plan.anchor === 'board' && session.board) {
      // An anchor reached over BLE: ask once to learn who it is.
      const probe = await session.board
        .request('anchor.attest', { device: device.address.slice(2), blockhash: '00'.repeat(32) }, 15_000)
        .catch(() => undefined);
      if (probe) {
        const signer = addressFromPublicKey(fromHex(`0x${probe.pubkey}`, 64));
        originVenueId = decodeAnchorAttestation(fromHex(`0x${probe.payload}`)).venueId;
        originAnchor = signer;
        realAnchorInUse = true;
        say(`origin venue ${originVenueId} uses the anchor heard over BLE (${originAnchor})`);
      } else {
        say('no anchor heard over BLE: the origin uses a simulated anchor');
      }
    }
    if (originVenueId !== ORIGIN.venueId) simulated.origin.setVenue(originVenueId);

    // With a real GPS that has a fix, the origin venue is wherever the device actually is.
    const origin = { ...ORIGIN, venueId: originVenueId };
    if (session.plan.position === 'board' && !session.mock) {
      const fix = await session.position();
      if (fix) {
        origin.latDeg = fix.latDeg;
        origin.lonDeg = fix.lonDeg;
        say(`real GPS fix: the origin venue is centred on where the device is now`);
      } else {
        say(
          'real GPS has no fix (normal indoors): readings will say "no fix" and get no geofence proof. Add --sim gps to simulate the position.',
        );
      }
    }
    const spots: Record<Where, { latDeg: number; lonDeg: number }> = {
      origin: { latDeg: origin.latDeg + 0.0001, lonDeg: origin.lonDeg + 0.0001 },
      road: ROAD,
      dock: { latDeg: DOCK.latDeg + 0.0001, lonDeg: DOCK.lonDeg + 0.0001 },
    };

    const admin = async (path: string, body?: unknown) => {
      const response = await fetch(`${stack.url}/v1/admin${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${stack.adminToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await response.json()) as any;
      if (!response.ok) throw new Error(`admin ${path}: ${response.status} ${JSON.stringify(json)}`);
      return json;
    };

    // The lot's limits. With a real sensor on a desk, 2–8 °C would breach on the first reading, so
    // the limits are set around what it measures now; warming it or breathing on it then breaches.
    let limits = COLD_CHAIN;
    const range = text(flags, 'temp-range');
    if (range) {
      const [low, high] = range.split(':').map(Number);
      if (low === undefined || high === undefined || !(low < high))
        throw new Error('--temp-range wants <min>:<max> in °C, e.g. 15:28');
      limits = { ...COLD_CHAIN, tempMinCenti: Math.round(low * 100), tempMaxCenti: Math.round(high * 100) };
    } else if (session.plan.climate === 'board' && session.board && !session.mock) {
      const now = await session.board.request('climate.read');
      limits = {
        tempMinCenti: Math.floor((now.temp_centi - 800) / 100) * 100,
        tempMaxCenti: Math.ceil((now.temp_centi + 400) / 100) * 100,
        rhMinCenti: 500,
        rhMaxCenti: Math.min(9500, Math.max(7000, Math.ceil((now.rh_centi + 1500) / 500) * 500)),
      };
      say(
        `real SHT31 reads ${(now.temp_centi / 100).toFixed(1)} °C, ${(now.rh_centi / 100).toFixed(0)} %RH: this lot allows ` +
          `${limits.tempMinCenti / 100}–${limits.tempMaxCenti / 100} °C and up to ${limits.rhMaxCenti / 100} %RH (override with --temp-range)`,
      );
    }
    const band = `${limits.tempMinCenti / 100}–${limits.tempMaxCenti / 100} °C`;

    act('Setup');
    await admin('/venues', { ...origin, radiusM: 150, anchor: originAnchor });
    await admin('/venues', { ...DOCK, radiusM: 150, anchor: simulated.dock.address });
    say(`venues registered on Arkiv: ${origin.venueId} (${origin.name}), ${DOCK.venueId} (${DOCK.name})`);
    await admin('/devices', {
      certBundle: await device.certificate(),
      venueIds: [origin.venueId, DOCK.venueId],
      label: 'Pocket sensor #1',
    });
    say('device enrolled: its certificate chains the wallet to the secure element');
    const { depositor, buyer } = stack.hedera.accounts;
    const lot = await admin('/lots', {
      assetId: ASSET,
      title: 'Cold-chain pharma pallet #42',
      device: device.address,
      ...limits,
      units: 100,
      unitValueCents: 1800,
      endsAt: Math.floor(Date.now() / 1000) + 3 * 86_400,
      disputeWindowS: 14 * 86_400,
      depositor: depositor.address,
    });
    await admin(`/lots/${ASSET}/investors`, { address: buyer.address });
    say(
      `lot ${ASSET} created: receipt token ${lot.token} (ATS), 100 units, ${band}, buyer ${buyer.address} allow-listed`,
    );

    const runner = new DeviceRunner(device, new HttpGatewayLink(stack.url));
    await runner.sync();

    // --- helpers shared by the script and the keyboard ---------------------------------------------
    // The script's temperatures are written for 2–8 °C; shift them to wherever this lot's band is.
    const shifted = (tempCenti: number) => tempCenti + (limits.tempMinCenti - COLD_CHAIN.tempMinCenti);
    const place = (to: Where, tempCenti?: number) => {
      where = to;
      const moved = steer.position(spots[to]);
      if (tempCenti !== undefined && !steer.climate(shifted(tempCenti), 4500))
        say('(the SHT31 is real: it reports what it measures)');
      return moved;
    };

    const report = async () => {
      const onChain = await stack.gateway.hedera.lot(ASSET);
      if (!onChain) return;
      const holding = await stack.gateway.hedera.holding(onChain.token, depositor.address);
      say(
        `   Hedera: lot is ${stateName(onChain.state)}${onChain.breachOpen ? ' (breach open)' : ''}; depositor holds ${holding.free} free, ${holding.frozen} frozen`,
      );
    };

    const reading = async () => {
      await runner.reading();
      const taken = decodeReading(fromHex(device.storedReading(device.seq)!.payload));
      const ok = isInRange(limits, taken.tempCenti, taken.rhCenti);
      say(
        `   reading #${taken.seq}: ${(taken.tempCenti / 100).toFixed(2)} °C, ${(taken.rhCenti / 100).toFixed(1)} %RH${ok ? '' : '   ← OUT OF RANGE'}`,
      );
      return { ...taken, inRange: ok };
    };

    const handoff = async (kind: CheckpointKindValue, timeoutMs = 90_000) => {
      const sent = await runner.checkpoint(kind);
      say(`   ${checkpointKindName(kind)} sent: ${sent.status} — not accepted until a decision arrives`);
      const decided = await runner.awaitDecision(sent.checkpointId, { timeoutMs });
      await stack.gateway.idle();
      say(
        `   decision: ${decided.status}${decided.decision ? ` (${decided.decision})` : ''}${decided.reason ? ` — ${decided.reason}` : ''}`,
      );
      return decided;
    };

    const hederaChain = hederaDevChain(stack.hedera.rpcUrl, stack.hedera.chainId);
    const hederaPublic = createPublicClient({ chain: hederaChain, transport: http(), pollingInterval: 100 });
    const listOnMarket = async (units: bigint, pricePerUnit: bigint) => {
      const onChain = await stack.gateway.hedera.lot(ASSET);
      if (!onChain) return;
      const wallet = createWalletClient({
        chain: hederaChain,
        transport: http(),
        account: privateKeyToAccount(depositor.privateKey),
      });
      await stack.gateway.hedera.allowlistSpender(onChain.token, stack.hedera.market);
      for (const hash of [
        await wallet.writeContract({
          address: onChain.token,
          abi: atsTokenAbi,
          functionName: 'approve',
          args: [stack.hedera.market, units],
        }),
        await wallet.writeContract({
          address: stack.hedera.market,
          abi: receiptMarketAbi,
          functionName: 'list',
          args: [onChain.token, units, pricePerUnit],
        }),
      ]) {
        await hederaPublic.waitForTransactionReceipt({ hash });
      }
      say(`   the depositor listed ${units} units on the market`);
    };

    /** With --pause: holds the journey so the buyer page can be looked at (Enter, or a timer). */
    const pause = async (message: string, defaultSeconds: number) => {
      if (!flags.pause) return;
      const seconds = Number(text(flags, 'pause') ?? 0);
      say(message);
      if (process.stdin.isTTY && !seconds) {
        say('press Enter to continue the journey');
        process.stdin.resume();
        await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
        process.stdin.pause();
      } else {
        const wait = seconds ? Math.min(seconds, defaultSeconds * 2) : defaultSeconds;
        say(`continuing in ${wait} s`);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      }
    };

    const stopSigning = runner.startSigning(150);

    if (flags.interactive) {
      act('Your turn');
      place('origin', 450);
      say(
        'the device is at the origin warehouse. Suggested: 1 (warehouse in), 2 (out), v, +, +, …, v, 3 (dock), i, 4.',
      );
      let outage = false;
      await runInteractive({
        session,
        runner,
        intervalMs: Math.max(2, Number(text(flags, 'interval') ?? 8)) * 1000,
        home: spots.origin,
        say,
        extraKeys: {
          v: {
            help: 'move on: origin → road → dock (position and which anchor is in range)',
            run: () => {
              const next: Where = where === 'origin' ? 'road' : where === 'road' ? 'dock' : 'origin';
              say(
                `now at: ${next}${place(next) ? '' : ' (the GPS is real, so only the anchor in range changed)'}`,
              );
            },
          },
          o: {
            help: 'cut 0G off / bring it back (rehearse the safe stop)',
            run: () => {
              if (zgEnv)
                return say('decisions come from the real 0G Router: the outage rehearsal needs the stand-in');
              outage = !outage;
              stack.zg.setMode(outage ? 'down' : 'up');
              say(outage ? '0G is now UNREACHABLE: handoffs stay PENDING' : '0G is reachable again');
            },
          },
          i: {
            help: 'inspector: release the lot after a breach',
            run: async () => {
              await admin(`/lots/${ASSET}/release`, { inspectionRef: `0x${'ee'.repeat(32)}` });
              say('the inspector released the lot');
              await report();
            },
          },
          m: {
            help: 'depositor: list 40 units on the market',
            run: () => listOnMarket(40n, parseEther('0.02')),
          },
          s: { help: 'show the lot on Hedera', run: report },
        },
      });
      await stopSigning();
      return shutdown();
    }

    // --- the scripted journey -------------------------------------------------------------------
    act('1. Origin warehouse: custody accepted, receipt issued');
    place('origin', 450);
    await reading();
    await reading();
    const first = await handoff(CheckpointKind.WAREHOUSE_IN);
    await report();
    if (first.status !== 'ACCEPTED') {
      say('custody was not accepted, so nothing was issued and the scripted journey cannot go on.');
      say(
        '(with a real camera and the stand-in model this is expected: it cannot see. Use --sim camera, or set ZG_* for the real model.)',
      );
    } else {
      await listOnMarket(40n, parseEther('0.02'));

      // The receipt trades only while a venue holds the goods: this is the moment to buy.
      await pause(
        'the lot is in custody and 40 units are on offer: buy some on the buyer page now (pnpm web)',
        45,
      );

      act('2. Leaving the warehouse: transfers are restricted in transit');
      await reading();
      await handoff(CheckpointKind.WAREHOUSE_OUT);
      await report();

      act('3. On the road: the cooling fails');
      place('road', 520);
      await reading();
      if (steer.climate(limits.tempMaxCenti + 460, 4500)) {
        await reading();
      } else {
        say(
          `the SHT31 is real: push it out of ${band} now — hold it in your hand or breathe on it. Waiting up to 90 s for an out-of-range reading`,
        );
        const deadline = Date.now() + 90_000;
        let breached = false;
        while (!breached && Date.now() < deadline) {
          breached = !(await reading()).inRange;
          if (!breached) await new Promise((done) => setTimeout(done, 4_000));
        }
        if (!breached) say('no out-of-range reading: the journey continues without a breach');
      }

      act('4. Destination dock: 0G is unreachable — safe stop');
      place('dock', 610);
      await reading();
      if (zgEnv) {
        say('(decisions come from the real 0G Router, so the outage is not rehearsed here)');
        await handoff(CheckpointKind.DOCK_HANDOFF);
      } else {
        stack.zg.setMode('down');
        const sent = await runner.checkpoint(CheckpointKind.DOCK_HANDOFF);
        const waiting = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 5_000 });
        say(`   DOCK_HANDOFF sent with 0G down: ${waiting.status} — ${waiting.reason ?? 'no decision'}`);
        say(
          `   the device shows ${session.lastStatus().state}; no decision was made up, the token was not touched`,
        );
        await report();

        act('5. 0G answers again: the handoff is judged on the evidence');
        stack.zg.setMode('up');
        const decided = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 90_000 });
        await stack.gateway.idle();
        say(
          `   decision: ${decided.status}${decided.decision ? ` (${decided.decision})` : ''}${decided.reason ? ` — ${decided.reason}` : ''}`,
        );
      }
      await report();

      const frozen = (await stack.gateway.hedera.lot(ASSET))?.state === LotState.FROZEN;
      if (frozen) {
        await pause(
          "the lot is frozen: on the buyer page every holder's units now show as frozen and buying is refused",
          15,
        );
        act('6. Inspection: the inspector releases the lot');
        await admin(`/lots/${ASSET}/release`, { inspectionRef: `0x${'ee'.repeat(32)}` });
        await report();
      }

      act(`${frozen ? '7' : '6'}. Final delivery`);
      steer.climate(shifted(480), 4500);
      await reading();
      await handoff(CheckpointKind.FINAL_DELIVERY);
      await report();
    }

    act('Done');
    const status = stack.gateway.status();
    say(
      `readings published on Arkiv: ${status.readings.published}/${status.readings.total}; checkpoints: ${status.checkpoints.map((c) => c.outcome ?? c.stage).join(', ')}`,
    );
    await stopSigning();
    if (flags.once) return shutdown();

    console.log(`
  The stack is still running. Open the buyer page in another terminal:

      pnpm web          then  http://localhost:5173

  Ctrl-C stops everything (the local chains keep no state).
`);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await shutdown();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`\n${(error as Error).stack ?? error}`);
    process.exit(1);
  },
);
