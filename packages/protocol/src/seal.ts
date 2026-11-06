/**
 * Seal evidence — what the device observed about the lot's tamper seal at a checkpoint.
 *
 * It is a small UTF-8 JSON record, because what a device can observe depends on the hardware it
 * was built with. Any combination of these is valid, as long as there is at least one:
 *
 *   photo      a picture of the seal (device camera, or the gateway's camera when the board has
 *              none); the record carries its hash, the image travels alongside
 *   nfc        an NFC seal tag read with a PN532: UID, and the tamper-loop state for tags that
 *              have one (NTAG 213 TT, NTAG 424 DNA TagTamper)
 *   enclosure  the state of a tamper switch on the device's own case
 *
 * The checkpoint payload commits to SHA-256 of the exact bytes sent (`seal_hash`), so there is
 * no canonical form to agree on: firmware hashes the bytes it produced and a verifier hashes the
 * bytes it received.
 */
import { type Hex, ProtocolError, toHex, utf8 } from './bytes';
import { sha256 } from './crypto';

export type SealPhotoSource = 'device-camera' | 'gateway-camera' | 'file' | 'simulated';
export type TamperState = 'closed' | 'open' | 'unknown';

export type SealEvidence = {
  v: 1;
  photo?: { sha256: Hex; mime: string; source: SealPhotoSource };
  nfc?: {
    /** Tag UID as hex (4, 7 or 10 bytes). */
    uid: Hex;
    tagType?: string;
    /** State of the tag's tamper loop, for tags that have one. */
    tamper?: TamperState;
    /** The tag's read counter, when it has one. */
    counter?: number;
    /** NDEF text or URI on the tag (an NTAG 424 DNA puts its authenticated message here). */
    ndef?: string;
  };
  enclosure?: { closed: boolean; openCount?: number };
};

const HEX_RE = /^0x[0-9a-f]+$/;
const MAX_SEAL_BYTES = 4096;

export function encodeSealEvidence(evidence: SealEvidence): Uint8Array {
  assertSealEvidence(evidence);
  const bytes = utf8(JSON.stringify(evidence));
  if (bytes.length > MAX_SEAL_BYTES) throw new ProtocolError('seal evidence record is too large');
  return bytes;
}

export function sealHash(record: Uint8Array): Hex {
  return toHex(sha256(record));
}

/** Parses a seal evidence record as received. Throws {@link ProtocolError} if it is malformed. */
export function decodeSealEvidence(record: Uint8Array): SealEvidence {
  if (record.length > MAX_SEAL_BYTES) throw new ProtocolError('seal evidence record is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record));
  } catch {
    throw new ProtocolError('seal evidence is not valid UTF-8 JSON');
  }
  assertSealEvidence(parsed);
  return parsed;
}

function assertSealEvidence(input: unknown): asserts input is SealEvidence {
  const evidence = input as SealEvidence;
  if (typeof evidence !== 'object' || evidence === null || evidence.v !== 1) {
    throw new ProtocolError('seal evidence must be a version 1 record');
  }
  const { photo, nfc, enclosure } = evidence;
  if (!photo && !nfc && !enclosure) throw new ProtocolError('seal evidence is empty');
  if (photo) {
    if (typeof photo.sha256 !== 'string' || !/^0x[0-9a-f]{64}$/.test(photo.sha256)) {
      throw new ProtocolError('seal photo hash must be a lowercase 32-byte hex string');
    }
    if (typeof photo.mime !== 'string' || !/^image\/[a-z0-9.+-]+$/.test(photo.mime)) {
      throw new ProtocolError('seal photo must have an image media type');
    }
    if (!['device-camera', 'gateway-camera', 'file', 'simulated'].includes(photo.source)) {
      throw new ProtocolError('seal photo source is unknown');
    }
  }
  if (nfc) {
    if (typeof nfc.uid !== 'string' || !HEX_RE.test(nfc.uid) || nfc.uid.length > 22) {
      throw new ProtocolError('NFC tag UID must be lowercase hex of at most 10 bytes');
    }
    if (nfc.tamper !== undefined && !['closed', 'open', 'unknown'].includes(nfc.tamper)) {
      throw new ProtocolError('NFC tamper state is unknown');
    }
    if (nfc.counter !== undefined && (!Number.isInteger(nfc.counter) || nfc.counter < 0)) {
      throw new ProtocolError('NFC counter must be a non-negative integer');
    }
  }
  if (enclosure && typeof enclosure.closed !== 'boolean') {
    throw new ProtocolError('enclosure state must be a boolean');
  }
}

/**
 * Whether the hardware itself reported tampering — independent of what any model later thinks
 * of a photo. Reported in the reading summary given to the decision model.
 */
export function sealReportsTamper(evidence: SealEvidence): boolean {
  return evidence.nfc?.tamper === 'open' || evidence.enclosure?.closed === false;
}
