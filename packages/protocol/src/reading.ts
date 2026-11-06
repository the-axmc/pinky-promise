/**
 * PPR1 — one sensor reading, 144 bytes, signed by the device wallet.
 *
 *   off  len  field
 *     0    4  magic           "PPR1"
 *     4   20  device          device wallet address
 *    24   32  asset_id        lot id, ASCII, zero-padded
 *    56    4  temp_centi      int32, hundredths of a degree Celsius
 *    60    4  rh_centi        uint32, hundredths of a percent relative humidity
 *    64   32  gps_commitment  SHA-256(lat_u ‖ lon_u ‖ salt), see gps.ts
 *    96    8  ts              uint64, unix seconds
 *   104    8  seq             uint64, strictly increasing per device
 *   112   32  blockhash       a recent Arkiv block hash: the reading cannot predate that block
 *
 *   digest    = SHA-256(payload)
 *   signature = secp256k1(digest), 65 bytes r ‖ s ‖ v
 *
 * The layout is fixed-width on purpose: firmware fills a struct, the Hedera contract slices
 * calldata, and the geofence circuit hashes exactly three SHA-256 blocks.
 */
import {
  type Hex,
  ProtocolError,
  asciiFixed,
  concat,
  equalBytes,
  fromHex,
  i32be,
  readAsciiFixed,
  readI32,
  readU32,
  readU64,
  toHex,
  u32be,
  u64be,
  utf8,
} from './bytes';
import { type Address, normalizeAddress, sameAddress, secpRecover, secpSign, sha256 } from './crypto';

export const READING_MAGIC = utf8('PPR1');
export const READING_LENGTH = 144;
/** Byte offset of the GPS commitment — the geofence circuit and the contract both rely on it. */
export const READING_GPS_OFFSET = 64;

export type Reading = {
  device: Address;
  assetId: string;
  /** Hundredths of a degree Celsius: 4.25 °C is 425. */
  tempCenti: number;
  /** Hundredths of a percent relative humidity: 45.5 % is 4550. */
  rhCenti: number;
  gpsCommitment: Hex;
  /** Unix seconds. */
  ts: number;
  seq: number;
  blockhash: Hex;
};

export function encodeReading(reading: Reading): Uint8Array {
  const payload = concat(
    READING_MAGIC,
    fromHex(reading.device, 20),
    asciiFixed(reading.assetId, 32),
    i32be(reading.tempCenti),
    u32be(reading.rhCenti),
    fromHex(reading.gpsCommitment, 32),
    u64be(reading.ts),
    u64be(reading.seq),
    fromHex(reading.blockhash, 32),
  );
  if (payload.length !== READING_LENGTH) throw new ProtocolError('reading encoding bug: wrong length');
  return payload;
}

export function decodeReading(payload: Uint8Array): Reading {
  if (payload.length !== READING_LENGTH) {
    throw new ProtocolError(`reading must be ${READING_LENGTH} bytes, got ${payload.length}`);
  }
  if (!equalBytes(payload.subarray(0, 4), READING_MAGIC)) throw new ProtocolError('not a PPR1 reading');
  return {
    device: toHex(payload.subarray(4, 24)),
    assetId: readAsciiFixed(payload.subarray(24, 56)),
    tempCenti: readI32(payload, 56),
    rhCenti: readU32(payload, 60),
    gpsCommitment: toHex(payload.subarray(64, 96)),
    ts: readU64(payload, 96),
    seq: readU64(payload, 104),
    blockhash: toHex(payload.subarray(112, 144)),
  };
}

export function readingDigest(payload: Uint8Array): Uint8Array {
  if (payload.length !== READING_LENGTH) throw new ProtocolError('reading payload has the wrong length');
  return sha256(payload);
}

/** A reading as it travels: the exact signed bytes and the signature over their digest. */
export type SignedReading = { payload: Hex; sig: Hex };

export function signReading(reading: Reading, deviceSecret: Uint8Array): SignedReading {
  const payload = encodeReading(reading);
  return { payload: toHex(payload), sig: toHex(secpSign(readingDigest(payload), deviceSecret)) };
}

export type VerifiedReading = {
  reading: Reading;
  payload: Uint8Array;
  digest: Uint8Array;
  signature: Uint8Array;
  /** The device's public key (x ‖ y), recovered from the signature. */
  publicKey: Uint8Array;
};

/**
 * Decodes a signed reading and checks that the signature was made by the device named inside
 * it. Throws {@link ProtocolError} otherwise. Whether that device is one we trust is a separate
 * question, answered by the device certificate and the registry.
 */
export function verifyReading(signed: SignedReading): VerifiedReading {
  const payload = fromHex(signed.payload, READING_LENGTH);
  const signature = fromHex(signed.sig, 65);
  const reading = decodeReading(payload);
  const digest = readingDigest(payload);
  const { address, publicKey } = secpRecover(digest, signature);
  if (!sameAddress(address, reading.device)) {
    throw new ProtocolError(`reading signed by ${address}, but it names device ${reading.device}`);
  }
  return {
    reading: { ...reading, device: normalizeAddress(reading.device) },
    payload,
    digest,
    signature,
    publicKey,
  };
}
