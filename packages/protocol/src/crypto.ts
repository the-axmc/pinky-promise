/**
 * The two signature schemes of the system and the one hash.
 *
 * - SHA-256 is the only digest. An ESP32 computes it in hardware, the EVM has it as a precompile
 *   and a Noir circuit can afford it, so the same digest is checked in firmware, on Hedera and
 *   inside the geofence proof.
 * - secp256k1 is the device wallet (and the gateway attestor and the venue anchor). Signatures
 *   are 65 bytes `r ‖ s ‖ v` with v = 27 or 28 and low s — exactly what `ecrecover` accepts —
 *   over the raw 32-byte digest with no prefix.
 * - P-256 is the hardware root key (an ATECC608B on the real device). It signs once, to bind
 *   the wallet to the chip.
 */
import { p256 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { type Hex, ProtocolError, concat, equalBytes, fromHex, toHex } from './bytes';

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

// ---------------------------------------------------------------------------------------------
// secp256k1 — device wallet, gateway attestor, venue anchor
// ---------------------------------------------------------------------------------------------

/** A 20-byte account address, lowercase hex. Compare with {@link sameAddress}, never `===`. */
export type Address = Hex;

export function secpGenerateSecret(): Uint8Array {
  return secp256k1.utils.randomSecretKey();
}

/** The uncompressed public key without the 0x04 prefix: x ‖ y, 64 bytes. */
export function secpPublicKey(secret: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(secret, false).slice(1);
}

export function addressFromPublicKey(publicKey: Uint8Array): Address {
  if (publicKey.length !== 64) throw new ProtocolError('public key must be 64 bytes (x ‖ y)');
  return toHex(keccak256(publicKey).slice(12));
}

export function secpAddress(secret: Uint8Array): Address {
  return addressFromPublicKey(secpPublicKey(secret));
}

export function normalizeAddress(address: string): Address {
  return toHex(fromHex(address, 20));
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** EIP-55 mixed-case form, for display and for tools that insist on a checksum. */
export function checksumAddress(address: string): Address {
  const lower = normalizeAddress(address).slice(2);
  const hash = toHex(keccak256(new TextEncoder().encode(lower))).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out as Address;
}

/** Signs a 32-byte digest. Deterministic (RFC 6979), low-s, `r ‖ s ‖ v` with v = 27 | 28. */
export function secpSign(digest: Uint8Array, secret: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new ProtocolError('digest must be 32 bytes');
  const recovered = secp256k1.sign(digest, secret, { prehash: false, lowS: true, format: 'recovered' });
  // noble lays it out as recovery ‖ r ‖ s; the EVM wants r ‖ s ‖ v.
  return concat(recovered.slice(1), Uint8Array.of(27 + recovered[0]!));
}

export type Recovered = { address: Address; publicKey: Uint8Array };

/** Recovers the signer of a digest. Throws on a malformed, high-s or unrecoverable signature. */
export function secpRecover(digest: Uint8Array, signature: Uint8Array): Recovered {
  if (digest.length !== 32) throw new ProtocolError('digest must be 32 bytes');
  if (signature.length !== 65) throw new ProtocolError('signature must be 65 bytes (r ‖ s ‖ v)');
  const v = signature[64]!;
  if (v !== 27 && v !== 28) throw new ProtocolError(`signature v must be 27 or 28, got ${v}`);
  const rs = signature.slice(0, 64);
  let compressed: Uint8Array;
  try {
    compressed = secp256k1.recoverPublicKey(concat(Uint8Array.of(v - 27), rs), digest, { prehash: false });
  } catch {
    throw new ProtocolError('signature does not recover to a public key');
  }
  const publicKey = secp256k1.Point.fromBytes(compressed).toBytes(false).slice(1);
  // Recovery alone accepts high-s; verify() with lowS rejects the malleable twin.
  if (!secp256k1.verify(rs, digest, compressed, { prehash: false, lowS: true })) {
    throw new ProtocolError('signature is not a valid low-s signature');
  }
  return { address: addressFromPublicKey(publicKey), publicKey };
}

export function secpVerify(digest: Uint8Array, signature: Uint8Array, expected: string): boolean {
  try {
    return sameAddress(secpRecover(digest, signature).address, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// P-256 — hardware root key (ATECC608B)
// ---------------------------------------------------------------------------------------------

export function p256GenerateSecret(): Uint8Array {
  return p256.utils.randomSecretKey();
}

/** x ‖ y, 64 bytes — the form an ATECC608B returns from GenKey. */
export function p256PublicKey(secret: Uint8Array): Uint8Array {
  return p256.getPublicKey(secret, false).slice(1);
}

/** Signs a 32-byte digest: `r ‖ s`, 64 bytes — the form an ATECC608B returns from Sign. */
export function p256Sign(digest: Uint8Array, secret: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new ProtocolError('digest must be 32 bytes');
  // The chip does not normalise s, so neither side of the protocol may require low-s here.
  return p256.sign(digest, secret, { prehash: false, lowS: false });
}

export function p256Verify(digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (digest.length !== 32 || signature.length !== 64 || publicKey.length !== 64) return false;
  try {
    return p256.verify(signature, digest, concat(Uint8Array.of(4), publicKey), { prehash: false, lowS: false });
  } catch {
    return false;
  }
}

export { equalBytes };
