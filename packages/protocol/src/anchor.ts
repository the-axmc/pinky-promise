/**
 * PPA1 — venue anchor attestation, 96 bytes, signed by the venue's anchor key.
 *
 * The geofence proof gives privacy, not authenticity: a GPS spoofer still produces valid proofs.
 * The anchor is the authenticity layer. It is a second microcontroller bolted to the venue; at a
 * checkpoint the device hands it a fresh nonce over BLE and the anchor co-signs it, which shows
 * the device was within radio range of that venue.
 *
 * The nonce is the same recent block hash the device puts in its checkpoint. That makes the
 * attestation fresh without the anchor needing a clock: it cannot have been signed before that
 * block existed, and the checkpoint lands on chain a few blocks later.
 *
 *   off  len  field
 *     0    4  magic      "PPA1"
 *     4   32  venue_id   ASCII, zero-padded
 *    36   20  device     the device wallet that asked
 *    56   32  blockhash  the nonce
 *    88    8  counter    the anchor's own monotonic counter
 *
 *   digest    = SHA-256(payload)       — goes into the checkpoint's anchor_digest field
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
  readU64,
  toHex,
  u64be,
  utf8,
} from './bytes';
import { type Address, secpRecover, secpSign, sha256 } from './crypto';

export const ANCHOR_MAGIC = utf8('PPA1');
export const ANCHOR_LENGTH = 96;

export type AnchorAttestation = { venueId: string; device: Address; blockhash: Hex; counter: number };

export function encodeAnchorAttestation(attestation: AnchorAttestation): Uint8Array {
  return concat(
    ANCHOR_MAGIC,
    asciiFixed(attestation.venueId, 32),
    fromHex(attestation.device, 20),
    fromHex(attestation.blockhash, 32),
    u64be(attestation.counter),
  );
}

export function decodeAnchorAttestation(payload: Uint8Array): AnchorAttestation {
  if (payload.length !== ANCHOR_LENGTH) {
    throw new ProtocolError(`anchor attestation must be ${ANCHOR_LENGTH} bytes, got ${payload.length}`);
  }
  if (!equalBytes(payload.subarray(0, 4), ANCHOR_MAGIC))
    throw new ProtocolError('not a PPA1 anchor attestation');
  return {
    venueId: readAsciiFixed(payload.subarray(4, 36)),
    device: toHex(payload.subarray(36, 56)),
    blockhash: toHex(payload.subarray(56, 88)),
    counter: readU64(payload, 88),
  };
}

export type SignedAnchorAttestation = { payload: Hex; sig: Hex };

export function signAnchorAttestation(
  attestation: AnchorAttestation,
  anchorSecret: Uint8Array,
): SignedAnchorAttestation {
  const payload = encodeAnchorAttestation(attestation);
  return { payload: toHex(payload), sig: toHex(secpSign(sha256(payload), anchorSecret)) };
}

export type VerifiedAnchorAttestation = {
  attestation: AnchorAttestation;
  digest: Uint8Array;
  /** The key that signed. The caller checks it is the anchor registered for the venue. */
  signer: Address;
};

export function verifyAnchorAttestation(signed: SignedAnchorAttestation): VerifiedAnchorAttestation {
  const payload = fromHex(signed.payload, ANCHOR_LENGTH);
  const digest = sha256(payload);
  const { address } = secpRecover(digest, fromHex(signed.sig, 65));
  return { attestation: decodeAnchorAttestation(payload), digest, signer: address };
}
