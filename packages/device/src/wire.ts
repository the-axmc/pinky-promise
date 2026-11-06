/**
 * The device ⇄ gateway protocol, version 1.
 *
 * The device always initiates (it is the BLE/WiFi client). JSON over HTTP today; the same
 * messages map onto BLE characteristics later. Binary fields are 0x-prefixed hex.
 *
 *   GET  /v1/device/context?device=0x…        what the device needs before it can sign
 *   POST /v1/device/readings                  one signed reading (+ its private GPS opening)
 *   POST /v1/device/checkpoints               a signed checkpoint with its seal evidence
 *   GET  /v1/device/checkpoints/:id?device=…  the decision for a checkpoint, once there is one
 *   GET  /v1/device/sign-requests?device=…    Arkiv transactions waiting for the device to sign
 *   POST /v1/device/signatures                the device's signatures for those transactions
 */
import type { Address, Hex, SignedLotProfile } from '@pinky/protocol';

/** A recent block of the Arkiv chain: its hash goes into payloads as the freshness anchor. */
export type ChainAnchor = { blockNumber: number; blockHash: Hex };

export type DeviceContext = {
  /** Gateway time, unix seconds (informational; the device uses its own clock). */
  time: number;
  arkiv: { chainId: number; anchor: ChainAnchor };
  /** The lot this device is assigned to, as signed by the registry. Null until assigned. */
  profile: SignedLotProfile | null;
};

/** The private opening of a reading's GPS commitment. Sent to the gateway only. */
export type WireOpening = { latUnits: number; lonUnits: number; salt: Hex };

export type ReadingRequest = { payload: Hex; sig: Hex; opening?: WireOpening };
export type ReadingResponse = { digest: Hex; accepted: boolean; duplicate?: boolean };

export type CheckpointRequest = {
  payload: Hex;
  sig: Hex;
  /** The seal evidence record (JSON), base64. Its SHA-256 must equal the payload's seal_hash. */
  seal: string;
  /** The seal photo, when the record references one: its SHA-256 must match the record's. */
  photo?: { mime: string; data: string };
  /** Venue-anchor attestation (PPA1) and its signature, when an anchor co-signed. */
  anchor?: { payload: Hex; sig: Hex };
};

/** What the device shows. PENDING means "not accepted": 0G has not decided (yet). */
export type CheckpointStatus = 'PENDING' | 'ACCEPTED' | 'REFUSED' | 'FROZEN' | 'ESCALATED' | 'BLOCKED_BY_BREACH';

export type CheckpointResponse = {
  checkpointId: Hex;
  status: CheckpointStatus;
  decision?: 'ACCEPT_CUSTODY' | 'REJECT' | 'ESCALATE';
  reason?: string;
};

/**
 * A legacy (EIP-155) transaction the gateway asks the device to sign. The device serialises
 * these fields itself and signs the hash of that, so it signs exactly what it reviewed.
 */
export type UnsignedTransaction = {
  chainId: number;
  nonce: number;
  /** Decimal strings: JSON has no bigint. */
  gas: string;
  gasPrice: string;
  to: Address;
  value: string;
  data: Hex;
};

export type SignRequest = {
  id: string;
  /** What the transaction is meant to publish; the device checks the calldata says the same. */
  purpose: 'reading' | 'checkpoint';
  transaction: UnsignedTransaction;
};

export type TransactionSignature = { r: Hex; s: Hex; yParity: 0 | 1 };

export type SignatureSubmission =
  | { id: string; signature: TransactionSignature }
  | { id: string; refused: string };
