/**
 * A lot is the physical thing being tracked and tokenized: one pallet, one coffee lot.
 *
 * PPL1 — lot profile, 80 bytes, signed by the registry key. It tells a device which lot it is
 * assigned to and what "in range" means for it. The device checks the registry's signature
 * before trusting it, so a gateway cannot quietly widen the limits.
 *
 *   off  len  field
 *     0    4  magic           "PPL1"
 *     4   32  asset_id        lot id, ASCII, zero-padded
 *    36   20  device          the device wallet assigned to the lot
 *    56    4  temp_min_centi  int32
 *    60    4  temp_max_centi  int32
 *    64    4  rh_min_centi    uint32
 *    68    4  rh_max_centi    uint32
 *    72    8  valid_until     uint64, unix seconds
 *
 *   digest    = SHA-256(payload)
 *   signature = secp256k1(digest), 65 bytes r ‖ s ‖ v
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
import { type Address, secpRecover, secpSign, sha256 } from './crypto';

export const LOT_PROFILE_MAGIC = utf8('PPL1');
export const LOT_PROFILE_LENGTH = 80;

/** The acceptable band for a lot, in hundredths (of °C and of %RH). Bounds are inclusive. */
export type Thresholds = {
  tempMinCenti: number;
  tempMaxCenti: number;
  rhMinCenti: number;
  rhMaxCenti: number;
};

export function assertThresholds(thresholds: Thresholds): void {
  if (thresholds.tempMinCenti > thresholds.tempMaxCenti)
    throw new ProtocolError('temperature band is inverted');
  if (thresholds.rhMinCenti > thresholds.rhMaxCenti) throw new ProtocolError('humidity band is inverted');
  if (thresholds.rhMaxCenti > 10_000) throw new ProtocolError('humidity cannot exceed 100 %');
}

/** The single definition of a breach. The Hedera contract implements the same comparison. */
export function isInRange(thresholds: Thresholds, tempCenti: number, rhCenti: number): boolean {
  return (
    tempCenti >= thresholds.tempMinCenti &&
    tempCenti <= thresholds.tempMaxCenti &&
    rhCenti >= thresholds.rhMinCenti &&
    rhCenti <= thresholds.rhMaxCenti
  );
}

export type LotProfile = Thresholds & { assetId: string; device: Address; validUntil: number };

export function encodeLotProfile(profile: LotProfile): Uint8Array {
  assertThresholds(profile);
  return concat(
    LOT_PROFILE_MAGIC,
    asciiFixed(profile.assetId, 32),
    fromHex(profile.device, 20),
    i32be(profile.tempMinCenti),
    i32be(profile.tempMaxCenti),
    u32be(profile.rhMinCenti),
    u32be(profile.rhMaxCenti),
    u64be(profile.validUntil),
  );
}

export function decodeLotProfile(payload: Uint8Array): LotProfile {
  if (payload.length !== LOT_PROFILE_LENGTH) {
    throw new ProtocolError(`lot profile must be ${LOT_PROFILE_LENGTH} bytes, got ${payload.length}`);
  }
  if (!equalBytes(payload.subarray(0, 4), LOT_PROFILE_MAGIC))
    throw new ProtocolError('not a PPL1 lot profile');
  const profile: LotProfile = {
    assetId: readAsciiFixed(payload.subarray(4, 36)),
    device: toHex(payload.subarray(36, 56)),
    tempMinCenti: readI32(payload, 56),
    tempMaxCenti: readI32(payload, 60),
    rhMinCenti: readU32(payload, 64),
    rhMaxCenti: readU32(payload, 68),
    validUntil: readU64(payload, 72),
  };
  assertThresholds(profile);
  return profile;
}

export type SignedLotProfile = { payload: Hex; sig: Hex };

export function signLotProfile(profile: LotProfile, registrySecret: Uint8Array): SignedLotProfile {
  const payload = encodeLotProfile(profile);
  return { payload: toHex(payload), sig: toHex(secpSign(sha256(payload), registrySecret)) };
}

/** Returns the profile and who signed it; the caller checks the signer is the registry it trusts. */
export function verifyLotProfile(signed: SignedLotProfile): { profile: LotProfile; signer: Address } {
  const payload = fromHex(signed.payload, LOT_PROFILE_LENGTH);
  const { address } = secpRecover(sha256(payload), fromHex(signed.sig, 65));
  return { profile: decodeLotProfile(payload), signer: address };
}

/** A lot id as the `bytes32` the Hedera contract keys lots by: the ASCII, zero-padded right. */
export function assetIdToBytes32(assetId: string): Hex {
  return toHex(asciiFixed(assetId, 32));
}

export function bytes32ToAssetId(value: Hex): string {
  return readAsciiFixed(fromHex(value, 32));
}

// ---------------------------------------------------------------------------------------------
// ISIN — Asset Tokenization Studio refuses to deploy a security without a well-formed one
// ---------------------------------------------------------------------------------------------

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The ISIN check digit: letters expand to two digits (A = 10 … Z = 35), then Luhn. */
export function isinCheckDigit(body: string): number {
  if (!/^[A-Z0-9]{11}$/.test(body)) throw new ProtocolError('ISIN body must be 11 characters of A-Z 0-9');
  let digits = '';
  for (const char of body) digits += BASE36.indexOf(char).toString();
  let sum = 0;
  let double = true; // the rightmost digit is doubled
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidIsin(isin: string): boolean {
  return /^[A-Z0-9]{12}$/.test(isin) && isinCheckDigit(isin.slice(0, 11)) === Number(isin[11]);
}

/**
 * A deterministic, well-formed identifier for a lot's receipt token. The "ZZ" prefix is in the
 * ISO 3166 user-assigned range, so it can never collide with (or pass for) an ISIN issued by a
 * real numbering agency.
 */
export function isinForLot(assetId: string): string {
  const hash = sha256(asciiFixed(assetId, 32));
  let body = 'ZZ';
  for (let i = 0; i < 9; i++) body += BASE36[hash[i]! % 36];
  return body + isinCheckDigit(body);
}
