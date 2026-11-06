/**
 * The gateway's own working state, kept in one JSON file.
 *
 * None of it is the system of record: readings and checkpoints are on Arkiv, episode logs on
 * 0G Storage, token state on Hedera. This file is what the gateway needs to pick up where it
 * left off — what is still waiting to be published, which checkpoints are still undecided,
 * and the per-lot view keys that decrypt the episode logs.
 *
 * GPS openings are deliberately not part of it: they live in memory until the geofence proof
 * is made and are then dropped.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address, Hex, SignedLotProfile, Thresholds, Venue } from '@pinky/protocol';
import type { CheckpointStatus } from '@pinky/device';

export type VenueRecord = Venue & { venueHash: Hex; entityKey?: Hex };

export type DeviceRecord = {
  address: Address;
  certBundle: Hex;
  /** secp256k1 public key x ‖ y of the device wallet (from its certificate). */
  walletPubkey: Hex;
  venueIds: string[];
  label: string;
  /** Highest reading or checkpoint seq accepted from this device. */
  lastSeq: number;
  /** seq of the last checkpoint accepted; checkpoints must arrive in order. */
  lastCheckpointSeq: number;
  entityKey?: Hex;
};

export type LotRecord = Thresholds & {
  assetId: string;
  title: string;
  device: Address;
  signedProfile: SignedLotProfile;
  token: Address;
  units: number;
  unitValueCents: number;
  endsAt: number;
  disputeWindowS: number;
  /** Decrypts this lot's episode logs. Shared only with parties entitled to raw readings. */
  viewKey: Hex;
  /** Receives the receipt units when custody is first accepted. */
  depositor?: Address;
  issued: boolean;
  entityKey?: Hex;
};

export type ReadingRecord = {
  digest: Hex;
  payload: Hex;
  sig: Hex;
  assetId: string;
  device: Address;
  seq: number;
  ts: number;
  inRange: boolean;
  anchorBlock: number;
  /** The venue whose geofence contained the reading, if any. */
  venueId?: string;
  arkiv: 'queued' | 'published' | 'refused';
  arkivError?: string;
  entityKey?: Hex;
  proof: 'none' | 'queued' | 'published' | 'failed';
  proofError?: string;
};

/** How far a checkpoint has got. Each stage is completed once and survives a restart. */
export type CheckpointStage =
  /** Waiting for a decision from 0G. This is the safe stop: nothing has been touched. */
  | 'AWAITING_DECISION'
  /** 0G decided; the episode log is not on 0G Storage yet. */
  | 'DECIDED'
  /** Episode log stored and the decision attested. */
  | 'ATTESTED'
  /** Decided record published on Arkiv. */
  | 'PUBLISHED'
  /** Applied to the Hedera oracle: done. */
  | 'APPLIED'
  /** Could not be applied (for example the lot's state changed). Needs an operator. */
  | 'FAILED';

export type CheckpointRecord = {
  id: Hex;
  assetId: string;
  device: Address;
  payload: Hex;
  sig: Hex;
  /** The seal evidence record (JSON text) and the photo, as received. */
  sealRecord: string;
  photo?: { mime: string; base64: string };
  anchor?: { payload: Hex; sig: Hex; venueId: string };
  venueId?: string;
  receivedAt: number;
  stage: CheckpointStage;
  /** Attempts that produced no decision, oldest first. */
  failedAttempts: Array<{ at: number; error: string; kind: string }>;
  nextAttemptAt: number;
  /** Whether the PENDING record has been published on Arkiv. */
  pendingPublished: boolean;
  decision?: {
    decision: 'ACCEPT_CUSTODY' | 'REJECT' | 'ESCALATE';
    reason: string;
    requestId: string;
    model: string;
    provider?: string;
    teeVerified?: boolean | null;
    source: '0g-router' | 'dev-mock';
    prompt: { system: string; user: string };
    rawAnswer: string;
    latencyMs: number;
    decidedAt: number;
  };
  breach?: boolean;
  /** PPR1 payload and signature of the reading that proves the breach. */
  breachReading?: { payload: Hex; sig: Hex };
  stateBefore?: string;
  outcome?: Exclude<CheckpointStatus, 'PENDING'>;
  episodeRoot?: Hex;
  episodeTx?: Hex;
  attestation?: { payload: Hex; sig: Hex };
  arkivKey?: Hex;
  hederaTx?: Hex;
  error?: string;
};

type Snapshot = {
  venues: Record<string, VenueRecord>;
  devices: Record<string, DeviceRecord>;
  lots: Record<string, LotRecord>;
  readings: Record<string, ReadingRecord>;
  checkpoints: Record<string, CheckpointRecord>;
};

const EMPTY: Snapshot = { venues: {}, devices: {}, lots: {}, readings: {}, checkpoints: {} };

export class GatewayStore {
  readonly #path: string | undefined;
  #data: Snapshot;
  #dirty = false;
  #timer: NodeJS.Timeout | undefined;

  /** Without a path the store lives in memory only (tests). */
  constructor(path?: string) {
    this.#path = path;
    this.#data = structuredClone(EMPTY);
    if (path) {
      try {
        this.#data = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(path, 'utf8')) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  get venues() {
    return this.#data.venues;
  }
  get devices() {
    return this.#data.devices;
  }
  get lots() {
    return this.#data.lots;
  }
  get readings() {
    return this.#data.readings;
  }
  get checkpoints() {
    return this.#data.checkpoints;
  }

  device(address: string): DeviceRecord | undefined {
    return this.#data.devices[address.toLowerCase()];
  }

  /** A device's readings with first ≤ seq ≤ last, in seq order. */
  readingsInWindow(device: Address, firstSeq: number, lastSeq: number): ReadingRecord[] {
    const wanted = device.toLowerCase();
    return Object.values(this.#data.readings)
      .filter((r) => r.device === wanted && r.seq >= firstSeq && r.seq <= lastSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Marks the state as changed; it is written to disk shortly after (and on flush()). */
  touch(): void {
    this.#dirty = true;
    if (!this.#path || this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), 200);
    this.#timer.unref?.();
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#path || !this.#dirty) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#data));
    renameSync(temporary, this.#path);
    this.#dirty = false;
  }
}
