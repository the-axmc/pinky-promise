/**
 * Runs a device by hand: a reading every few seconds, a checkpoint when a key is pressed. The
 * command line uses it against any gateway, and the local demo adds its own keys (move between
 * venues, cut 0G off, call the inspector).
 */
import { emitKeypressEvents } from 'node:readline';
import { CheckpointKind, type CheckpointKindValue, checkpointKindName } from '@pinky/protocol';
import { LinkError } from './link';
import type { DeviceRunner } from './runner';
import type { DeviceSession } from './session';

export type ExtraKey = { help: string; run: () => Promise<void> | void };

export type InteractiveOptions = {
  session: DeviceSession;
  runner: DeviceRunner;
  /** Milliseconds between automatic readings. */
  intervalMs: number;
  /** Where the simulated GPS is when it has a fix. */
  home?: { latDeg: number; lonDeg: number };
  /** More single-key commands, shown in the help line. */
  extraKeys?: Record<string, ExtraKey>;
  say?: (line: string) => void;
};

const CHECKPOINT_KEYS: Record<string, CheckpointKindValue> = {
  '1': CheckpointKind.WAREHOUSE_IN,
  '2': CheckpointKind.WAREHOUSE_OUT,
  '3': CheckpointKind.DOCK_HANDOFF,
  '4': CheckpointKind.FINAL_DELIVERY,
};

/** Resolves when the operator quits (q or Ctrl-C). */
export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const { session, runner } = options;
  const { device, steer } = session;
  const say = options.say ?? ((line: string) => console.log(line));
  let stopping = false;

  // One thing at a time: a reading and a checkpoint must not interleave their sequence numbers.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (label: string, job: () => Promise<void> | void) => {
    queue = queue.then(job).catch((error) => {
      const detail = error instanceof LinkError ? `${error.message} ${JSON.stringify(error.detail)}` : (error as Error).message;
      say(`${label} failed: ${detail}`);
    });
    return queue;
  };

  while (!device.profile && !stopping) {
    try {
      await runner.sync();
    } catch (error) {
      say(`cannot reach the gateway: ${(error as Error).message}`);
    }
    if (!device.profile) {
      say('not assigned to a lot yet — enrol this device and create a lot for it; checking again in 5 s');
      await new Promise((done) => setTimeout(done, 5_000));
    }
  }
  const profile = device.profile!;
  say(
    `lot ${profile.assetId}: allowed ${profile.tempMinCenti / 100}–${profile.tempMaxCenti / 100} °C, ` +
      `${profile.rhMinCenti / 100}–${profile.rhMaxCenti / 100} %RH`,
  );
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
      const short = `${sent.checkpointId.slice(0, 12)}…`;
      say(`checkpoint ${short} sent — ${sent.status}: the handoff is NOT accepted until a decision arrives`);
      // Keep watching without holding up further readings.
      void (async () => {
        while (!stopping) {
          const now = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 20_000 }).catch(() => undefined);
          if (!now) continue;
          if (now.status !== 'PENDING') {
            return say(`checkpoint ${short} → ${now.status}${now.decision ? ` (${now.decision})` : ''}${now.reason ? `: ${now.reason}` : ''}`);
          }
          say(`checkpoint ${short} still PENDING — no decision yet, nothing is accepted${now.reason ? ` (${now.reason})` : ''}`);
        }
      })();
    });

  let simTemp = 450;
  let simSeal: 'intact' | 'broken' = 'intact';
  let simFix = true;
  const home = options.home ?? { latDeg: 19.0761, lonDeg: 72.8778 };
  steer.climate(simTemp, 4500);
  steer.position(home);

  const timer = setInterval(reading, options.intervalMs);
  void reading();

  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  const quit = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    await queue;
    await stopSigning();
    finished();
  };

  const extra = options.extraKeys ?? {};
  say('keys:  r reading   1 warehouse in   2 warehouse out   3 dock handoff   4 final delivery   q quit');
  say('       simulated parts only:  + / - temperature   b break/mend the seal   g GPS fix on/off');
  for (const [key, binding] of Object.entries(extra)) say(`       ${key} ${binding.help}`);

  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (_text, key: { name?: string; sequence?: string; ctrl?: boolean }) => {
      const pressed = key.sequence ?? '';
      if (pressed === 'q' || (key.ctrl && key.name === 'c')) return void quit();
      if (pressed === 'r') return void reading();
      if (CHECKPOINT_KEYS[pressed]) return void checkpoint(CHECKPOINT_KEYS[pressed]!);
      if (extra[pressed]) return void enqueue(extra[pressed]!.help, () => extra[pressed]!.run());
      if (pressed === '+' || pressed === '-') {
        simTemp += pressed === '+' ? 50 : -50;
        say(steer.climate(simTemp, 4500) ? `simulated temperature ${(simTemp / 100).toFixed(1)} °C` : 'the SHT31 is real — warm or cool the sensor itself');
      } else if (pressed === 'b') {
        simSeal = simSeal === 'intact' ? 'broken' : 'intact';
        say(steer.seal(simSeal) ? `simulated seal is now ${simSeal}` : 'the camera is real — point it at the seal you want it to see');
      } else if (pressed === 'g') {
        simFix = !simFix;
        say(steer.position(simFix ? home : null) ? `simulated GPS ${simFix ? 'has a fix' : 'lost its fix'}` : 'the GPS is real — it reports what it sees');
      }
    });
  } else {
    say('(not a terminal: keys are off; readings continue until the process is stopped)');
  }
  process.once('SIGINT', () => void quit());
  process.once('SIGTERM', () => void quit());
  return done;
}
