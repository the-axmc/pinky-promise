/**
 * What the device is willing to sign.
 *
 * The device wallet owns its Arkiv entities, so the device has to sign the transactions that
 * create them. The gateway builds those transactions. This module is the check in between: it
 * decodes the transaction and refuses unless it publishes, and only publishes, what the device
 * itself measured and signed.
 *
 * Rules:
 *  - legacy transaction to the Arkiv engine, on the expected chain, no value, capped fee;
 *  - only Create operations (never a transfer, patch, delete or extension), all readonly;
 *  - a Reading entity must match one of the device's own readings field for field, including
 *    the device's own verdict on whether it was in range;
 *  - a Checkpoint entity must carry the device's own checkpoint and a decision attestation
 *    that is signed by the configured attestor, is about that checkpoint, and is honest about
 *    breaches as far as the device can tell from its own readings.
 */
import {
  type Address,
  type Checkpoint,
  Decision,
  type Hex,
  ProtocolError,
  type Reading,
  checkpointKindName,
  concat,
  decisionName,
  decodeDecisionAttestation,
  fromHex,
  requestIdHash,
  sameAddress,
  secpVerify,
  sha256,
  toHex,
} from '@pinky/protocol';
import {
  ARKIV_ENGINE_ADDRESS,
  ARKIV_OPERATION,
  type DecodedCreate,
  SCHEMA_NAMES,
  decodeExecute,
  plainValue,
  readingValues,
} from '@pinky/protocol/arkiv';
import type { SignRequest } from './wire';

export type StoredReading = {
  reading: Reading;
  digest: Hex;
  sig: Hex;
  /** The device's own verdict against its registry-signed limits. */
  inRange: boolean;
  anchorBlock: number;
};

export type StoredCheckpoint = {
  checkpoint: Checkpoint;
  id: Hex;
  payload: Hex;
  sig: Hex;
  anchor?: { payload: Hex; sig: Hex };
  /** Whether a decided (non-PENDING) entity has been signed for it already. */
  decided?: boolean;
};

export type PolicyContext = {
  self: Address;
  arkivChainId: number;
  /** The gateway key allowed to relay 0G decisions. */
  attestor: Address;
  maxGas: bigint;
  /** Cap on gas × gasPrice for one transaction, in wei. */
  maxFeeWei: bigint;
  reading(digest: Hex): StoredReading | undefined;
  checkpoint(id: Hex): StoredCheckpoint | undefined;
  /** The device's readings with first ≤ seq ≤ last. */
  readingsInWindow(firstSeq: number, lastSeq: number): StoredReading[];
};

export type Review =
  | { ok: true; readings: Hex[]; checkpoints: Array<{ id: Hex; decision: string; outcome: string; reason: string }> }
  | { ok: false; reason: string };

const MAX_CREATES = 32;
const HASH_RE = /^0x[0-9a-f]{64}$/;

const OUTCOMES_FOR: Record<string, string[]> = {
  PENDING: ['PENDING'],
  ACCEPT_CUSTODY: ['ACCEPTED', 'BLOCKED_BY_BREACH'],
  REJECT: ['REFUSED', 'FROZEN'],
  ESCALATE: ['ESCALATED'],
};

/** Columns of a Checkpoint entity the gateway fills in; everything else must match the device. */
const CHECKPOINT_GATEWAY_COLUMNS = new Set([
  'decision',
  'outcome',
  'breach',
  'zg_request_id',
  'zg_model',
  'zg_provider',
  'zg_tee_verified',
  'zg_source',
  'episode_root',
  'reason',
  'venue_hash',
  'attestation',
  'attestor',
  'attestor_sig',
  'breach_reading',
  'decided_at',
]);

class Refusal extends Error {}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

export function reviewTransaction(request: SignRequest, context: PolicyContext): Review {
  try {
    const { transaction } = request;
    if (!sameAddress(transaction.to, ARKIV_ENGINE_ADDRESS)) refuse('not addressed to the Arkiv engine');
    if (transaction.chainId !== context.arkivChainId) refuse(`wrong chain id ${transaction.chainId}`);
    if (BigInt(transaction.value) !== 0n) refuse('transfers value');
    const gas = BigInt(transaction.gas);
    const gasPrice = BigInt(transaction.gasPrice);
    if (gas > context.maxGas) refuse(`gas limit ${gas} is above the device's cap`);
    if (gas * gasPrice > context.maxFeeWei) refuse('fee is above the device\'s cap');

    const decoded = decodeExecute(transaction.data);
    if (decoded.operations.length === 0) refuse('empty batch');
    if (decoded.operations.some((operation) => operation !== ARKIV_OPERATION.create)) {
      refuse('contains an operation other than create');
    }
    if (decoded.creates.length > MAX_CREATES) refuse('too many entities in one transaction');

    const readings: Hex[] = [];
    const checkpoints: Array<{ id: Hex; decision: string; outcome: string; reason: string }> = [];
    for (const create of decoded.creates) {
      if (!create.readonly || create.permissionlessExtension) refuse('entity is not created readonly');
      if (create.expiresAt === 0n && create.minLifetime === 0n) refuse('entity has no expiry');
      const schema = text(create, 'arkiv.schema');
      if (schema === SCHEMA_NAMES.reading) readings.push(reviewReading(create, context));
      else if (schema === SCHEMA_NAMES.checkpoint) checkpoints.push(reviewCheckpoint(create, context));
      else refuse(`unexpected entity type "${schema}"`);
    }
    return { ok: true, readings, checkpoints };
  } catch (error) {
    if (error instanceof Refusal || error instanceof ProtocolError) return { ok: false, reason: error.message };
    throw error;
  }
}

function attribute(create: DecodedCreate, name: string, type: string) {
  const found = create.attributes.get(name);
  if (!found) return refuse(`missing attribute "${name}"`);
  if (found.type !== type) return refuse(`attribute "${name}" has type ${found.type}, expected ${type}`);
  return found.value;
}
const text = (create: DecodedCreate, name: string) => attribute(create, name, 'str') as string;
const hexBytes = (create: DecodedCreate, name: string) => attribute(create, name, 'bytes') as Hex;

function reviewReading(create: DecodedCreate, context: PolicyContext): Hex {
  const digest = text(create, 'digest') as Hex;
  const own = context.reading(digest);
  if (!own) return refuse(`reading ${digest} was not produced by this device`);

  let venueHash: Hex | undefined;
  if (create.attributes.has('venue_hash')) {
    venueHash = text(create, 'venue_hash') as Hex;
    if (!HASH_RE.test(venueHash)) refuse('venue_hash is not a 32-byte hash');
  }
  const expected: Record<string, { type: string; value: unknown }> = {
    ...readingValues({ ...own, venueHash }),
  };
  const names = new Set([...Object.keys(expected), 'arkiv.schema']);
  for (const name of create.attributes.keys()) {
    if (!names.has(name)) refuse(`reading carries an unexpected attribute "${name}"`);
  }
  for (const [name, value] of Object.entries(expected)) {
    const actual = create.attributes.get(name);
    if (!actual) refuse(`reading is missing "${name}"`);
    if (actual!.type !== value.type || actual!.value !== plainValue(value)) {
      refuse(`reading attribute "${name}" does not match what the device measured`);
    }
  }
  return digest;
}

function reviewCheckpoint(create: DecodedCreate, context: PolicyContext) {
  const id = text(create, 'checkpoint_id') as Hex;
  const own = context.checkpoint(id);
  if (!own) return refuse(`checkpoint ${id} was not produced by this device`);
  const { checkpoint } = own;

  // 1. Everything the device itself produced must be reproduced exactly.
  const mine: Record<string, [string, unknown]> = {
    asset_id: ['str', checkpoint.assetId],
    device_id: ['addr', checkpoint.device.toLowerCase()],
    checkpoint_id: ['str', id],
    kind: ['str', checkpointKindName(checkpoint.kind)],
    seq: ['u64', BigInt(checkpoint.seq)],
    ts: ['u64', BigInt(checkpoint.ts)],
    first_seq: ['u64', BigInt(checkpoint.firstSeq)],
    last_seq: ['u64', BigInt(checkpoint.lastSeq)],
    payload: ['bytes', own.payload.toLowerCase()],
    sig: ['bytes', own.sig.toLowerCase()],
  };
  if (own.anchor) {
    mine.anchor_att = ['bytes', toHex(concat(fromHex(own.anchor.payload), fromHex(own.anchor.sig)))];
  }
  for (const [name, [type, value]] of Object.entries(mine)) {
    if (attribute(create, name, type) !== value) refuse(`checkpoint attribute "${name}" does not match the device's`);
  }
  for (const name of create.attributes.keys()) {
    if (name !== 'arkiv.schema' && !(name in mine) && !CHECKPOINT_GATEWAY_COLUMNS.has(name)) {
      refuse(`checkpoint carries an unexpected attribute "${name}"`);
    }
  }

  // 2. The decision must be the attestor's, about this checkpoint, and described consistently.
  const attestationPayload = fromHex(hexBytes(create, 'attestation'));
  const attestation = decodeDecisionAttestation(attestationPayload);
  if (attestation.checkpointDigest !== id) refuse('decision attestation is for another checkpoint');
  const attestor = attribute(create, 'attestor', 'addr') as string;
  if (!sameAddress(attestor, context.attestor)) refuse('decision is not from the configured attestor');
  if (!secpVerify(sha256(attestationPayload), fromHex(hexBytes(create, 'attestor_sig')), context.attestor)) {
    refuse('decision attestation signature is invalid');
  }
  const decision = decisionName(attestation.decision);
  if (text(create, 'decision') !== decision) refuse('decision column disagrees with the attestation');
  if (attribute(create, 'breach', 'bool') !== attestation.breach) refuse('breach column disagrees with the attestation');
  if (attribute(create, 'decided_at', 'u64') !== BigInt(attestation.decidedAt)) refuse('decided_at disagrees with the attestation');
  const outcome = text(create, 'outcome');
  if (!OUTCOMES_FOR[decision]!.includes(outcome)) refuse(`outcome ${outcome} is impossible for decision ${decision}`);
  const reason = text(create, 'reason');

  if (attestation.decision === Decision.PENDING) {
    if (create.attributes.has('zg_request_id') || create.attributes.has('episode_root')) {
      refuse('a pending record cannot claim a 0G request or an episode log');
    }
  } else {
    if (own.decided) refuse('a decision for this checkpoint was already signed');
    if (requestIdHash(text(create, 'zg_request_id')) !== attestation.requestIdHash) {
      refuse('0G request id does not match the attestation');
    }
    if (text(create, 'episode_root') !== attestation.episodeRoot) refuse('episode root does not match the attestation');
  }

  // 3. Honesty about breaches, judged against the device's own readings.
  const window = context.readingsInWindow(checkpoint.firstSeq, checkpoint.lastSeq);
  const ownBreach = window.some((reading) => !reading.inRange);
  if (attestation.decision !== Decision.PENDING && attestation.breach !== ownBreach) {
    refuse(ownBreach ? 'decision hides an out-of-range reading' : 'decision claims a breach the device did not measure');
  }
  if (create.attributes.has('breach_reading')) {
    const packed = fromHex(hexBytes(create, 'breach_reading'));
    const evidence = context.reading(toHex(sha256(packed.subarray(0, 144))));
    if (!evidence || evidence.inRange || evidence.sig.toLowerCase() !== toHex(packed.subarray(144))) {
      refuse('breach evidence is not an out-of-range reading of this device');
    }
    if (evidence!.reading.seq < checkpoint.firstSeq || evidence!.reading.seq > checkpoint.lastSeq) {
      refuse('breach evidence is outside the checkpoint window');
    }
  } else if (attestation.breach) {
    refuse('a breach is attested without its evidence');
  }

  return { id, decision, outcome, reason };
}
