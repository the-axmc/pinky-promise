/**
 * PPD1 — device certificate, 105 bytes, signed twice.
 *
 * Two keys, one chain of trust. The hardware root key (P-256, inside an ATECC608B, never
 * extractable) signs this certificate once, at registration, binding the secp256k1 device wallet
 * to the chip. The wallet countersigns the same digest to prove it holds its own key. From then
 * on the wallet signs every reading and owns its Arkiv entities.
 *
 *   off  len  field
 *     0    4  magic       "PPD1"
 *     4   20  device      device wallet address
 *    24   64  hw_pubkey   P-256 public key, x ‖ y
 *    88    9  hw_serial   the ATECC608B's 9-byte serial number
 *    97    8  issued_at   uint64, unix seconds
 *
 *   digest     = SHA-256(payload)
 *   hw_sig     = P-256(digest), 64 bytes r ‖ s        — "this chip vouches for this wallet"
 *   wallet_sig = secp256k1(digest), 65 bytes r ‖ s ‖ v — "this wallet accepts"
 *
 * Wire form ("certificate bundle"): payload ‖ hw_sig ‖ wallet_sig, 234 bytes.
 *
 * What the certificate does not prove by itself is that hw_pubkey belongs to a genuine chip.
 * That is the registry's job: it enrols the device by writing the bundle to an Arkiv entity it
 * owns. In production the chip's Microchip-issued certificate would be checked at that point.
 */
import { type Hex, ProtocolError, concat, equalBytes, fromHex, readU64, toHex, u64be, utf8 } from './bytes';
import {
  type Address,
  p256PublicKey,
  p256Sign,
  p256Verify,
  sameAddress,
  secpAddress,
  secpRecover,
  secpSign,
  sha256,
} from './crypto';

export const CERT_MAGIC = utf8('PPD1');
export const CERT_LENGTH = 105;
export const CERT_BUNDLE_LENGTH = CERT_LENGTH + 64 + 65;

export type DeviceCert = {
  device: Address;
  /** P-256 public key, x ‖ y, as hex. */
  hwPubkey: Hex;
  /** 9-byte chip serial number, as hex. */
  hwSerial: Hex;
  issuedAt: number;
};

export function encodeDeviceCert(cert: DeviceCert): Uint8Array {
  return concat(
    CERT_MAGIC,
    fromHex(cert.device, 20),
    fromHex(cert.hwPubkey, 64),
    fromHex(cert.hwSerial, 9),
    u64be(cert.issuedAt),
  );
}

export function decodeDeviceCert(payload: Uint8Array): DeviceCert {
  if (payload.length !== CERT_LENGTH) {
    throw new ProtocolError(`device certificate must be ${CERT_LENGTH} bytes, got ${payload.length}`);
  }
  if (!equalBytes(payload.subarray(0, 4), CERT_MAGIC))
    throw new ProtocolError('not a PPD1 device certificate');
  return {
    device: toHex(payload.subarray(4, 24)),
    hwPubkey: toHex(payload.subarray(24, 88)),
    hwSerial: toHex(payload.subarray(88, 97)),
    issuedAt: readU64(payload, 97),
  };
}

/** Issues the certificate bundle. On hardware, `hwSecret` never leaves the chip. */
export function issueDeviceCert(input: {
  hwSecret: Uint8Array;
  walletSecret: Uint8Array;
  hwSerial: Hex;
  issuedAt: number;
}): Hex {
  const payload = encodeDeviceCert({
    device: secpAddress(input.walletSecret),
    hwPubkey: toHex(p256PublicKey(input.hwSecret)),
    hwSerial: input.hwSerial,
    issuedAt: input.issuedAt,
  });
  const digest = sha256(payload);
  return toHex(concat(payload, p256Sign(digest, input.hwSecret), secpSign(digest, input.walletSecret)));
}

export type VerifiedDeviceCert = {
  cert: DeviceCert;
  digest: Uint8Array;
  /** The device wallet's secp256k1 public key (x ‖ y) — a public input of the geofence proof. */
  walletPublicKey: Uint8Array;
};

/** Checks both signatures of a certificate bundle. Throws {@link ProtocolError} if either fails. */
export function verifyDeviceCert(bundle: Hex | Uint8Array): VerifiedDeviceCert {
  const bytes = typeof bundle === 'string' ? fromHex(bundle, CERT_BUNDLE_LENGTH) : bundle;
  if (bytes.length !== CERT_BUNDLE_LENGTH) {
    throw new ProtocolError(`certificate bundle must be ${CERT_BUNDLE_LENGTH} bytes, got ${bytes.length}`);
  }
  const payload = bytes.subarray(0, CERT_LENGTH);
  const hwSig = bytes.subarray(CERT_LENGTH, CERT_LENGTH + 64);
  const walletSig = bytes.subarray(CERT_LENGTH + 64);
  const cert = decodeDeviceCert(payload);
  const digest = sha256(payload);

  if (!p256Verify(digest, hwSig, fromHex(cert.hwPubkey, 64))) {
    throw new ProtocolError('device certificate: hardware key signature is invalid');
  }
  const wallet = secpRecover(digest, walletSig);
  if (!sameAddress(wallet.address, cert.device)) {
    throw new ProtocolError('device certificate: not countersigned by the wallet it names');
  }
  return { cert, digest, walletPublicKey: wallet.publicKey };
}
