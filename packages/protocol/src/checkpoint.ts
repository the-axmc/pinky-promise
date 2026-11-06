/**
 * PPC1 — a custody checkpoint, 221 bytes, signed by the device wallet.
 *
 * At a handoff the device photographs the tamper seal and bundles the photo with the readings
 * taken since the previous checkpoint. This payload commits to all of it.
 *
 *   off  len  field
 *     0    4  magic           "PPC1"
 *     4   20  device          device wallet address
 *    24   32  asset_id        lot id, ASCII, zero-padded
 *    56    1  kind            1 WAREHOUSE_IN, 2 WAREHOUSE_OUT, 3 DOCK_HANDOFF, 4 FINAL_DELIVERY
 *    57    8  ts              uint64, unix seconds
 *    65    8  seq             uint64, same counter as readings; greater than every bundled one
 *    73    8  first_seq       seq of the first bundled reading
 *    81    8  last_seq        seq of the last bundled reading
 *    89    4  reading_count   uint32, number of bundled readings (at least 1)
 *    93   32  readings_root   SHA-256(digest_1 ‖ digest_2 ‖ … ‖ digest_n), in seq order
 *   125   32  photo_hash      SHA-256 of the seal photo file
 *   157   32  anchor_digest   digest of the venue anchor attestation, or 32 zero bytes
 *   189   32  blockhash       a recent Arkiv block hash
 *
 *   digest    = SHA-256(payload)       — also the checkpoint's id everywhere else
 *   signature = secp256k1(digest), 65 bytes r ‖ s ‖ v
 */
import {
  type Hex,
  ProtocolError,
  asciiFixed,
  concat,
  equalBytes,
  fromHex,
  readAsciiFixed,
  readU32,
  readU64,
  readU8,
  toHex,
  u32be,
  u64be,
  u8,
  utf8,
} from './bytes';
import { type Address, normalizeAddress, sameAddress, secpRecover, secpSign, sha256 } from './crypto';

export const CHECKPOINT_MAGIC = utf8('PPC1');
export const CHECKPOINT_LENGTH = 221;
export const ZERO_32: Hex = `0x${'00'.repeat(32)}`;

/** Where in its journey the lot changes hands. The numeric values are part of the wire format. */
export const CheckpointKind = {
  /** Goods enter a warehouse: custody passes to the warehouse. */
  WAREHOUSE_IN: 1,
  /** Goods leave a warehouse: custody passes to the carrier. */
  WAREHOUSE_OUT: 2,
  /** The carrier hands over at a dock: custody passes to the receiving venue. */
  DOCK_HANDOFF: 3,
  /** The lot reaches its consignee: the receipt becomes redeemable. */
  FINAL_DELIVERY: 4,
} as const;
export type CheckpointKindName = keyof typeof CheckpointKind;
export type CheckpointKindValue = (typeof CheckpointKind)[CheckpointKindName];

export function checkpointKindName(value: number): CheckpointKindName {
  const entry = Object.entries(CheckpointKind).find(([, v]) => v === value);
  if (!entry) throw new ProtocolError(`unknown checkpoint kind ${value}`);
  return entry[0] as CheckpointKindName;
}

export type Checkpoint = {
  device: Address;
  assetId: string;
  kind: CheckpointKindValue;
  ts: number;
  seq: number;
  firstSeq: number;
  lastSeq: number;
  readingCount: number;
  readingsRoot: Hex;
  photoHash: Hex;
  /** {@link ZERO_32} when the venue has no anchor or it was out of range. */
  anchorDigest: Hex;
  blockhash: Hex;
};

/** The commitment to the bundled readings: the hash of their digests, in seq order. */
export function readingsRoot(digests: Uint8Array[]): Uint8Array {
  if (digests.length === 0) throw new ProtocolError('a checkpoint must bundle at least one reading');
  for (const digest of digests) {
    if (digest.length !== 32) throw new ProtocolError('reading digests must be 32 bytes');
  }
  return sha256(concat(...digests));
}

export function encodeCheckpoint(checkpoint: Checkpoint): Uint8Array {
  checkpointKindName(checkpoint.kind);
  if (checkpoint.readingCount < 1) throw new ProtocolError('a checkpoint must bundle at least one reading');
  if (checkpoint.firstSeq > checkpoint.lastSeq) throw new ProtocolError('first_seq is after last_seq');
  if (checkpoint.seq <= checkpoint.lastSeq) {
    throw new ProtocolError('checkpoint seq must be greater than the last bundled reading seq');
  }
  const payload = concat(
    CHECKPOINT_MAGIC,
    fromHex(checkpoint.device, 20),
    asciiFixed(checkpoint.assetId, 32),
    u8(checkpoint.kind),
    u64be(checkpoint.ts),
    u64be(checkpoint.seq),
    u64be(checkpoint.firstSeq),
    u64be(checkpoint.lastSeq),
    u32be(checkpoint.readingCount),
    fromHex(checkpoint.readingsRoot, 32),
    fromHex(checkpoint.photoHash, 32),
    fromHex(checkpoint.anchorDigest, 32),
    fromHex(checkpoint.blockhash, 32),
  );
  if (payload.length !== CHECKPOINT_LENGTH) throw new ProtocolError('checkpoint encoding bug: wrong length');
  return payload;
}

export function decodeCheckpoint(payload: Uint8Array): Checkpoint {
  if (payload.length !== CHECKPOINT_LENGTH) {
    throw new ProtocolError(`checkpoint must be ${CHECKPOINT_LENGTH} bytes, got ${payload.length}`);
  }
  if (!equalBytes(payload.subarray(0, 4), CHECKPOINT_MAGIC)) throw new ProtocolError('not a PPC1 checkpoint');
  const kind = readU8(payload, 56);
  checkpointKindName(kind);
  const checkpoint: Checkpoint = {
    device: toHex(payload.subarray(4, 24)),
    assetId: readAsciiFixed(payload.subarray(24, 56)),
    kind: kind as CheckpointKindValue,
    ts: readU64(payload, 57),
    seq: readU64(payload, 65),
    firstSeq: readU64(payload, 73),
    lastSeq: readU64(payload, 81),
    readingCount: readU32(payload, 89),
    readingsRoot: toHex(payload.subarray(93, 125)),
    photoHash: toHex(payload.subarray(125, 157)),
    anchorDigest: toHex(payload.subarray(157, 189)),
    blockhash: toHex(payload.subarray(189, 221)),
  };
  if (checkpoint.readingCount < 1) throw new ProtocolError('checkpoint bundles no readings');
  if (checkpoint.firstSeq > checkpoint.lastSeq) throw new ProtocolError('checkpoint first_seq is after last_seq');
  if (checkpoint.seq <= checkpoint.lastSeq) throw new ProtocolError('checkpoint seq is not after its readings');
  return checkpoint;
}

export function checkpointDigest(payload: Uint8Array): Uint8Array {
  if (payload.length !== CHECKPOINT_LENGTH) throw new ProtocolError('checkpoint payload has the wrong length');
  return sha256(payload);
}

export type SignedCheckpoint = { payload: Hex; sig: Hex };

export function signCheckpoint(checkpoint: Checkpoint, deviceSecret: Uint8Array): SignedCheckpoint {
  const payload = encodeCheckpoint(checkpoint);
  return { payload: toHex(payload), sig: toHex(secpSign(checkpointDigest(payload), deviceSecret)) };
}

export type VerifiedCheckpoint = {
  checkpoint: Checkpoint;
  payload: Uint8Array;
  digest: Uint8Array;
  signature: Uint8Array;
};

/** Decodes a signed checkpoint and checks it was signed by the device it names. */
export function verifyCheckpoint(signed: SignedCheckpoint): VerifiedCheckpoint {
  const payload = fromHex(signed.payload, CHECKPOINT_LENGTH);
  const signature = fromHex(signed.sig, 65);
  const checkpoint = decodeCheckpoint(payload);
  const digest = checkpointDigest(payload);
  const { address } = secpRecover(digest, signature);
  if (!sameAddress(address, checkpoint.device)) {
    throw new ProtocolError(`checkpoint signed by ${address}, but it names device ${checkpoint.device}`);
  }
  return { checkpoint: { ...checkpoint, device: normalizeAddress(checkpoint.device) }, payload, digest, signature };
}
