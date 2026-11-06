/**
 * PPX1 — decision attestation, 110 bytes, signed by the gateway's attestor key.
 *
 * At a checkpoint a 0G vision model decides whether to accept the handoff. The model's answer
 * reaches the chain through this message: the gateway attests "for this checkpoint, 0G request
 * such-and-such returned this decision, and the full episode is stored at this 0G Storage root".
 *
 * The trust boundary matters. The attestor relays an operational decision. It never certifies
 * that a temperature was real — only the device signature does that, which is why a freeze
 * additionally needs a device-signed out-of-range reading (see policy.ts).
 *
 *   off  len  field
 *     0    4  magic              "PPX1"
 *     4   32  checkpoint_digest  SHA-256 of the PPC1 payload this decides
 *    36    1  decision           0 PENDING, 1 ACCEPT_CUSTODY, 2 REJECT, 3 ESCALATE
 *    37    1  breach             1 if a bundled reading is out of range, else 0
 *    38   32  request_id_hash    SHA-256 of the 0G request id (UTF-8), zero while PENDING
 *    70   32  episode_root       0G Storage merkle root of the episode log, zero while PENDING
 *   102    8  decided_at         uint64, unix seconds
 *
 *   digest    = SHA-256(payload)
 *   signature = secp256k1(digest), 65 bytes r ‖ s ‖ v
 */
import {
  type Hex,
  ProtocolError,
  concat,
  equalBytes,
  fromHex,
  readU64,
  readU8,
  toHex,
  u64be,
  u8,
  utf8,
} from './bytes';
import { type Address, secpRecover, secpSign, sha256 } from './crypto';

export const ATTESTATION_MAGIC = utf8('PPX1');
export const ATTESTATION_LENGTH = 110;

/** The numeric values are part of the wire format and of the Hedera contract's ABI. */
export const Decision = {
  /** No decision yet: 0G was unreachable or has not answered. Nothing may act on this. */
  PENDING: 0,
  ACCEPT_CUSTODY: 1,
  REJECT: 2,
  ESCALATE: 3,
} as const;
export type DecisionName = keyof typeof Decision;
export type DecisionValue = (typeof Decision)[DecisionName];

export function decisionName(value: number): DecisionName {
  const entry = Object.entries(Decision).find(([, v]) => v === value);
  if (!entry) throw new ProtocolError(`unknown decision ${value}`);
  return entry[0] as DecisionName;
}

export type DecisionAttestation = {
  checkpointDigest: Hex;
  decision: DecisionValue;
  breach: boolean;
  requestIdHash: Hex;
  episodeRoot: Hex;
  decidedAt: number;
};

export function requestIdHash(requestId: string): Hex {
  return toHex(sha256(utf8(requestId)));
}

export function encodeDecisionAttestation(attestation: DecisionAttestation): Uint8Array {
  decisionName(attestation.decision);
  return concat(
    ATTESTATION_MAGIC,
    fromHex(attestation.checkpointDigest, 32),
    u8(attestation.decision),
    u8(attestation.breach ? 1 : 0),
    fromHex(attestation.requestIdHash, 32),
    fromHex(attestation.episodeRoot, 32),
    u64be(attestation.decidedAt),
  );
}

export function decodeDecisionAttestation(payload: Uint8Array): DecisionAttestation {
  if (payload.length !== ATTESTATION_LENGTH) {
    throw new ProtocolError(
      `decision attestation must be ${ATTESTATION_LENGTH} bytes, got ${payload.length}`,
    );
  }
  if (!equalBytes(payload.subarray(0, 4), ATTESTATION_MAGIC)) {
    throw new ProtocolError('not a PPX1 decision attestation');
  }
  const decision = readU8(payload, 36);
  decisionName(decision);
  const breach = readU8(payload, 37);
  if (breach > 1) throw new ProtocolError('attestation breach flag must be 0 or 1');
  return {
    checkpointDigest: toHex(payload.subarray(4, 36)),
    decision: decision as DecisionValue,
    breach: breach === 1,
    requestIdHash: toHex(payload.subarray(38, 70)),
    episodeRoot: toHex(payload.subarray(70, 102)),
    decidedAt: readU64(payload, 102),
  };
}

export type SignedDecisionAttestation = { payload: Hex; sig: Hex };

export function signDecisionAttestation(
  attestation: DecisionAttestation,
  attestorSecret: Uint8Array,
): SignedDecisionAttestation {
  const payload = encodeDecisionAttestation(attestation);
  return { payload: toHex(payload), sig: toHex(secpSign(sha256(payload), attestorSecret)) };
}

export type VerifiedDecisionAttestation = {
  attestation: DecisionAttestation;
  digest: Uint8Array;
  /** The key that signed. The caller checks it is the attestor registered for the lot. */
  signer: Address;
};

export function verifyDecisionAttestation(signed: SignedDecisionAttestation): VerifiedDecisionAttestation {
  const payload = fromHex(signed.payload, ATTESTATION_LENGTH);
  const digest = sha256(payload);
  const { address } = secpRecover(digest, fromHex(signed.sig, 65));
  return { attestation: decodeDecisionAttestation(payload), digest, signer: address };
}
