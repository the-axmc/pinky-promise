/**
 * The demo's journey as steps something else can drive: a hosted page presses "next", where
 * `pnpm demo` has a keyboard. The acts are the same as the scripted demo's, on a simulated device.
 *
 * One journey runs at a time, and a step that is already running makes `next()` a no-op, so
 * several visitors pressing the button at once cannot interleave handoffs.
 */
import {
  type DeviceSession,
  DeviceRunner,
  HttpGatewayLink,
  SimulatedAnchor,
  openDeviceSession,
} from '@pinky/device';
import {
  type Address,
  CheckpointKind,
  type CheckpointKindValue,
  LotState,
  checkpointKindName,
  decodeReading,
  fromHex,
  isInRange,
} from '@pinky/protocol';
import { atsTokenAbi, receiptMarketAbi } from '@pinky/protocol/hedera';
import { http, createPublicClient, createWalletClient, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { DemoStack } from './demo-stack';

const ORIGIN = { venueId: 'WH-MUM-01', name: 'Mumbai cold store', latDeg: 19.076, lonDeg: 72.8777 };
const DOCK = { venueId: 'DK-PNQ-02', name: 'Pune receiving dock', latDeg: 18.5204, lonDeg: 73.8567 };
const SPOTS = {
  origin: { latDeg: ORIGIN.latDeg + 0.0001, lonDeg: ORIGIN.lonDeg + 0.0001 },
  road: { latDeg: 18.8, lonDeg: 73.3 },
  dock: { latDeg: DOCK.latDeg + 0.0001, lonDeg: DOCK.lonDeg + 0.0001 },
};
/** A cold-chain pharma pallet: 2–8 °C, 20–70 % relative humidity. */
const COLD_CHAIN = { tempMinCenti: 200, tempMaxCenti: 800, rhMinCenti: 2000, rhMaxCenti: 7000 };
const HEDERA_CHAINS = [295, 296, 297];

type Where = keyof typeof SPOTS;
export type JourneyStep = { title: string; does: string; look: string };

export const JOURNEY_STEPS: JourneyStep[] = [
  {
    title: 'Origin warehouse',
    does: 'The device takes two readings and asks for custody. The decision model judges the seal photo and the readings; 100 units are issued and 40 offered.',
    look: 'The lot is In custody. Open "Why trust this record?", then buy some units.',
  },
  {
    title: 'Leaving the warehouse',
    does: 'The goods go on the road and the handoff is recorded.',
    look: 'The lot is In transit: buying is off, because the token itself would refuse the transfer.',
  },
  {
    title: 'The cooling fails',
    does: 'On the road, one reading comes in at 12.6 °C against the 2–8 °C limit.',
    look: 'One ✕ on the readings strip. The public record says only "out of range": the value stays private.',
  },
  {
    title: 'Dock: the decision model is unreachable',
    does: 'The dock handoff is sent with the route to the model cut. This is the safe stop.',
    look: 'The handoff stays PENDING. No decision was made up and the token was not touched.',
  },
  {
    title: 'The model answers: REJECT',
    does: 'The route comes back. A REJECT plus the device-signed out-of-range reading, which the contract verifies itself, freezes every unit.',
    look: 'The lot is Frozen, your units are frozen too, and the 12.6 °C reading is disclosed.',
  },
  {
    title: 'Inspection',
    does: "The lot's inspector, the only account allowed to, releases it.",
    look: 'The lot is In custody again and units are free.',
  },
  {
    title: 'Final delivery',
    does: 'The temperature is back in range and the final handoff is accepted.',
    look: 'The lot is Delivered. Redeem your units, press "Use the demo key" for the raw values, and "Verify all in this browser" for the proofs.',
  },
];

export type JourneyStatus = {
  /** "stand-in" chains run on this server; "live" means the networks in the configuration. */
  mode: 'stand-in' | 'live';
  steps: JourneyStep[];
  /** Index of the next step to run; equal to steps.length when done; -1 with no lot prepared. */
  step: number;
  /** What is running right now, if anything. */
  running: string | null;
  assetId: string | null;
  log: string[];
  error: string | null;
};

export type JourneyOptions = {
  /** Prints progress as well as keeping it for the page. */
  echo?: (line: string) => void;
};

export class Journey {
  readonly #stack: DemoStack;
  readonly #echo: (line: string) => void;
  /** Real networks answer in seconds, not milliseconds. */
  readonly #patience: number;
  readonly #anchors = {
    origin: new SimulatedAnchor(`0x${'31'.repeat(32)}`),
    dock: new SimulatedAnchor(`0x${'32'.repeat(32)}`),
  };
  #where: Where = 'origin';
  #session: DeviceSession | undefined;
  #runner: DeviceRunner | undefined;
  #stopSigning: (() => Promise<void>) | undefined;
  #dockCheckpoint: `0x${string}` | undefined;
  #lots = 0;
  #step = -1;
  #running: string | null = null;
  #assetId: string | null = null;
  #log: string[] = [];
  #error: string | null = null;

  constructor(stack: DemoStack, options: JourneyOptions = {}) {
    this.#stack = stack;
    this.#echo = options.echo ?? (() => {});
    this.#patience = stack.live ? 300_000 : 90_000;
    this.#anchors.origin.setVenue(ORIGIN.venueId);
    this.#anchors.dock.setVenue(DOCK.venueId);
  }

  status(): JourneyStatus {
    return {
      mode: this.#stack.live ? 'live' : 'stand-in',
      steps: JOURNEY_STEPS,
      step: this.#step,
      running: this.#running,
      assetId: this.#assetId,
      log: this.#log,
      error: this.#error,
    };
  }

  /** Starts a fresh lot. False if something is already running. */
  restart(): boolean {
    if (this.#running) return false;
    // A lot nobody has touched yet is as good as new: pressing again must not pile up tokens.
    if (this.#step === 0 && !this.#error) return true;
    void this.#run('Preparing a new lot', async () => {
      await this.#closeDevice();
      await this.#prepare();
    });
    return true;
  }

  /** Runs the next step. False if something is running or the journey is over. */
  next(): boolean {
    if (this.#running || this.#step < 0 || this.#step >= JOURNEY_STEPS.length) return false;
    const index = this.#step;
    void this.#run(JOURNEY_STEPS[index]!.title, async () => {
      await this.#acts[index]!();
      this.#step = index + 1;
      if (this.#step === JOURNEY_STEPS.length) await this.#stopSigning?.();
    });
    return true;
  }

  /** Resolves when nothing is running. */
  async settled(timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#running) {
      if (Date.now() > deadline) throw new Error(`journey still running: ${this.#running}`);
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  async stop(): Promise<void> {
    await this.settled().catch(() => {});
    await this.#closeDevice();
  }

  async #run(label: string, job: () => Promise<void>): Promise<void> {
    this.#running = label;
    this.#error = null;
    this.#say(`── ${label}`);
    try {
      await job();
    } catch (error) {
      this.#error = (error as Error).message.split('\n')[0] ?? 'the step failed';
      this.#say(`✕ ${this.#error}`);
    } finally {
      this.#running = null;
    }
  }

  #say(line: string): void {
    this.#log = [...this.#log, line].slice(-200);
    this.#echo(line);
  }

  async #closeDevice(): Promise<void> {
    await this.#stopSigning?.().catch(() => {});
    await this.#session?.close().catch(() => {});
    this.#stopSigning = undefined;
    this.#session = undefined;
    this.#runner = undefined;
  }

  async #admin(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.#stack.url}/v1/admin${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.#stack.adminToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as any;
    if (!response.ok) throw new Error(`${path}: ${json.error ?? response.status}`);
    return json;
  }

  /** A lot id is used once on a real network: the token and the oracle entry are permanent. */
  #nextLotId(): string {
    this.#lots += 1;
    if (!this.#stack.live) return `LOT-${41 + this.#lots}`;
    const now = new Date();
    const two = (value: number) => String(value).padStart(2, '0');
    return `LOT-${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}-${two(now.getUTCHours())}${two(now.getUTCMinutes())}`;
  }

  async #prepare(): Promise<void> {
    const stack = this.#stack;
    this.#where = 'origin';
    this.#step = -1;
    this.#assetId = null;
    this.#dockCheckpoint = undefined;

    const session = await openDeviceSession({
      provisioning: {
        registry: stack.registry,
        attestor: stack.attestor,
        arkivChainId: stack.arkiv.chainId,
      },
      wrapAnchor: () => ({
        attest: async (request) => {
          if (this.#where === 'road') return null;
          return (this.#where === 'dock' ? this.#anchors.dock : this.#anchors.origin).attest(request);
        },
      }),
    });
    this.#session = session;
    const { device } = session;

    await this.#admin('/venues', { ...ORIGIN, radiusM: 150, anchor: this.#anchors.origin.address });
    await this.#admin('/venues', { ...DOCK, radiusM: 150, anchor: this.#anchors.dock.address });
    await this.#admin('/devices', {
      certBundle: await device.certificate(),
      venueIds: [ORIGIN.venueId, DOCK.venueId],
      label: 'Pocket sensor #1',
    });
    const assetId = this.#nextLotId();
    const lot = await this.#admin('/lots', {
      assetId,
      title: 'Cold-chain pharma pallet',
      device: device.address,
      ...COLD_CHAIN,
      units: 100,
      unitValueCents: 1800,
      endsAt: Math.floor(Date.now() / 1000) + 3 * 86_400,
      disputeWindowS: 14 * 86_400,
      depositor: stack.hedera.depositor.address,
    });
    if (stack.hedera.buyer) await this.#admin(`/lots/${assetId}/investors`, { address: stack.hedera.buyer });

    this.#runner = new DeviceRunner(device, new HttpGatewayLink(stack.url));
    await this.#runner.sync();
    this.#stopSigning = this.#runner.startSigning(stack.live ? 500 : 150);
    this.#assetId = assetId;
    this.#step = 0;
    this.#say(`lot ${assetId} created: receipt token ${lot.token}, device ${device.address}`);
  }

  #place(to: Where, tempCenti?: number): void {
    this.#where = to;
    this.#session!.steer.position(SPOTS[to]);
    if (tempCenti !== undefined) this.#session!.steer.climate(tempCenti, 4500);
  }

  async #reading(): Promise<void> {
    await this.#runner!.reading();
    const device = this.#session!.device;
    const taken = decodeReading(fromHex(device.storedReading(device.seq)!.payload));
    const ok = isInRange(COLD_CHAIN, taken.tempCenti, taken.rhCenti);
    this.#say(
      `reading #${taken.seq}: ${(taken.tempCenti / 100).toFixed(2)} °C${ok ? '' : ' — OUT OF RANGE'}`,
    );
  }

  async #handoff(kind: CheckpointKindValue): Promise<string> {
    const runner = this.#runner!;
    const sent = await runner.checkpoint(kind);
    this.#say(`${checkpointKindName(kind)} sent: ${sent.status}`);
    const decided = await runner.awaitDecision(sent.checkpointId, { timeoutMs: this.#patience });
    await this.#settleGateway();
    this.#say(this.#verdict(decided));
    return decided.status;
  }

  #verdict(decided: { status: string; decision?: string | undefined; reason?: string | undefined }): string {
    return `decision: ${decided.status}${decided.decision ? ` (${decided.decision})` : ''}${decided.reason ? ` — ${decided.reason}` : ''}`;
  }

  async #settleGateway(): Promise<void> {
    await this.#stack.gateway.idle(this.#patience, { device: this.#session!.device.address });
  }

  async #report(): Promise<void> {
    const stack = this.#stack;
    const lot = await stack.gateway.hedera.lot(this.#assetId!);
    if (!lot) return;
    const state = Object.entries(LotState).find(([, value]) => value === lot.state)?.[0] ?? lot.state;
    const held = await stack.gateway.hedera.holding(lot.token, stack.hedera.depositor.address);
    this.#say(`Hedera: lot is ${state}; depositor holds ${held.free} free, ${held.frozen} frozen`);
  }

  async #listOnMarket(units: bigint): Promise<void> {
    const stack = this.#stack;
    const lot = await stack.gateway.hedera.lot(this.#assetId!);
    if (!lot) throw new Error('the lot is not on Hedera');
    const { chain, depositor, market, chainId } = stack.hedera;
    // 0.02 HBAR a unit. On Hedera a contract counts in tinybar (8 decimals), elsewhere in wei.
    const price = HEDERA_CHAINS.includes(chainId) ? 2_000_000n : parseEther('0.02');
    const reader = createPublicClient({
      chain,
      transport: http(),
      pollingInterval: stack.live ? 2_000 : 100,
    });
    const wallet = createWalletClient({
      chain,
      transport: http(),
      account: privateKeyToAccount(depositor.privateKey),
    });
    await stack.gateway.hedera.allowlistSpender(lot.token, market);
    for (const hash of [
      await wallet.writeContract({
        address: lot.token as Address,
        abi: atsTokenAbi,
        functionName: 'approve',
        args: [market, units],
      }),
      await wallet.writeContract({
        address: market,
        abi: receiptMarketAbi,
        functionName: 'list',
        args: [lot.token as Address, units, price],
      }),
    ]) {
      await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    }
    this.#say(`the depositor listed ${units} units on the market`);
  }

  /** One function per entry of JOURNEY_STEPS, in the same order. */
  readonly #acts: Array<() => Promise<void>> = [
    async () => {
      this.#place('origin', 450);
      await this.#reading();
      await this.#reading();
      const status = await this.#handoff(CheckpointKind.WAREHOUSE_IN);
      await this.#report();
      if (status !== 'ACCEPTED') throw new Error(`custody was not accepted (${status})`);
      await this.#listOnMarket(40n);
    },
    async () => {
      await this.#reading();
      await this.#handoff(CheckpointKind.WAREHOUSE_OUT);
      await this.#report();
    },
    async () => {
      this.#place('road', 520);
      await this.#reading();
      this.#session!.steer.climate(COLD_CHAIN.tempMaxCenti + 460, 4500);
      await this.#reading();
    },
    async () => {
      this.#place('dock', 610);
      await this.#reading();
      const runner = this.#runner!;
      // A real model deciding for local chains has no route this demo can cut.
      if (!this.#stack.live && this.#stack.realModel) {
        this.#say('a real model decides here, so the outage is not rehearsed');
        await this.#handoff(CheckpointKind.DOCK_HANDOFF);
        await this.#report();
        return;
      }
      this.#stack.setOutage(true);
      const sent = await runner.checkpoint(CheckpointKind.DOCK_HANDOFF);
      this.#dockCheckpoint = sent.checkpointId;
      const waiting = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 5_000 });
      this.#say(`DOCK_HANDOFF sent with the model unreachable: ${waiting.status}`);
      this.#say(`the device shows ${this.#session!.lastStatus().state}; no decision was made up`);
      await this.#report();
    },
    async () => {
      if (!this.#dockCheckpoint) return this.#report();
      this.#stack.setOutage(false);
      const decided = await this.#runner!.awaitDecision(this.#dockCheckpoint!, {
        timeoutMs: this.#patience,
      });
      await this.#settleGateway();
      this.#say(this.#verdict(decided));
      await this.#report();
    },
    async () => {
      await this.#admin(`/lots/${this.#assetId}/release`, { inspectionRef: `0x${'ee'.repeat(32)}` });
      this.#say('the inspector released the lot');
      await this.#report();
    },
    async () => {
      this.#session!.steer.climate(480, 4500);
      await this.#reading();
      await this.#handoff(CheckpointKind.FINAL_DELIVERY);
      await this.#report();
    },
  ];
}
