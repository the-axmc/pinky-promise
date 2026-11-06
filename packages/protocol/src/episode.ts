/**
 * The episode log: everything that went into one custody decision, in one replayable record.
 *
 * It is what the gateway stores on 0G Storage for every checkpoint: the device-signed
 * checkpoint, the seal evidence, the raw signed readings of the window (the only place raw
 * temperature and humidity are kept), exactly what the 0G model was asked and what it answered
 * (with the 0G request id), and what the policy made of it. Anyone holding the lot's view key
 * can decrypt it, re-verify every signature and recompute the summary and the outcome.
 *
 * Encryption is the 0G Storage client's own symmetric format, so the 0G tools can decrypt it
 * too: one byte 0x01, a 16-byte nonce, then AES-256-CTR with the nonce as the initial counter.
 * Integrity comes from 0G's content addressing — the Merkle root of the ciphertext is what the
 * decision attestation and the Arkiv checkpoint point to.
 */
import { ctr } from '@noble/ciphers/aes.js';
import { type Hex, ProtocolError, concat, fromHex, toHex, utf8 } from './bytes';
import { type Address, randomBytes } from './crypto';
import { type Thresholds, isInRange } from './lot';
import { type Reading } from './reading';

const SYMMETRIC_VERSION = 1;
const HEADER_LENGTH = 17;

export function generateViewKey(): Hex {
  return toHex(randomBytes(32));
}

export function encryptEpisode(plaintext: Uint8Array, key: Uint8Array, nonce: Uint8Array = randomBytes(16)): Uint8Array {
  if (key.length !== 32) throw new ProtocolError('episode key must be 32 bytes');
  if (nonce.length !== 16) throw new ProtocolError('episode nonce must be 16 bytes');
  return concat(Uint8Array.of(SYMMETRIC_VERSION), nonce, ctr(key, nonce).encrypt(plaintext));
}

export function decryptEpisode(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new ProtocolError('episode key must be 32 bytes');
  if (ciphertext.length < HEADER_LENGTH || ciphertext[0] !== SYMMETRIC_VERSION) {
    throw new ProtocolError('not a symmetrically encrypted episode log');
  }
  return ctr(key, ciphertext.subarray(1, HEADER_LENGTH)).decrypt(ciphertext.subarray(HEADER_LENGTH));
}

// ---------------------------------------------------------------------------------------------
// The summary the decision model is given
// ---------------------------------------------------------------------------------------------

/**
 * Facts about a checkpoint's readings, computed from the signed payloads. The model reasons
 * over these; it is never asked whether they are true.
 */
export type ReadingSummary = {
  count: number;
  firstSeq: number;
  lastSeq: number;
  /** Sequence numbers missing between first and last: readings the gateway never received. */
  missingSeqs: number;
  spanSeconds: number;
  tempMinC: number;
  tempMaxC: number;
  tempMeanC: number;
  rhMinPct: number;
  rhMaxPct: number;
  limits: { tempMinC: number; tempMaxC: number; rhMinPct: number; rhMaxPct: number };
  outOfRange: number;
  /** How far the worst reading was outside the temperature band, in °C (0 when none). */
  worstTempExcursionC: number;
};

export function summarizeReadings(readings: Reading[], thresholds: Thresholds): ReadingSummary {
  if (readings.length === 0) throw new ProtocolError('cannot summarise an empty window');
  const sorted = [...readings].sort((a, b) => a.seq - b.seq);
  const temps = sorted.map((r) => r.tempCenti);
  const rhs = sorted.map((r) => r.rhCenti);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const worst = Math.max(
    0,
    ...sorted.map((r) => Math.max(thresholds.tempMinCenti - r.tempCenti, r.tempCenti - thresholds.tempMaxCenti)),
  );
  const round = (value: number) => Math.round(value) / 100;
  return {
    count: sorted.length,
    firstSeq: first.seq,
    lastSeq: last.seq,
    missingSeqs: last.seq - first.seq + 1 - sorted.length,
    spanSeconds: last.ts - first.ts,
    tempMinC: round(Math.min(...temps)),
    tempMaxC: round(Math.max(...temps)),
    tempMeanC: round(temps.reduce((sum, t) => sum + t, 0) / temps.length),
    rhMinPct: round(Math.min(...rhs)),
    rhMaxPct: round(Math.max(...rhs)),
    limits: {
      tempMinC: round(thresholds.tempMinCenti),
      tempMaxC: round(thresholds.tempMaxCenti),
      rhMinPct: round(thresholds.rhMinCenti),
      rhMaxPct: round(thresholds.rhMaxCenti),
    },
    outOfRange: sorted.filter((r) => !isInRange(thresholds, r.tempCenti, r.rhCenti)).length,
    worstTempExcursionC: round(worst),
  };
}

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

export type EpisodeDecision = {
  /** "0g-router" for a real 0G call; "dev-mock" for the local stand-in. */
  source: '0g-router' | 'dev-mock';
  /** The 0G request id of the call that produced this decision. */
  requestId: string;
  model: string;
  /** On-chain address of the 0G provider that served it. */
  provider?: string;
  /** Result of the Router's TEE signature check, when it was requested. */
  teeVerified?: boolean | null;
  decision: 'ACCEPT_CUSTODY' | 'REJECT' | 'ESCALATE';
  reason: string;
  /** What the model was asked (the image is the seal photo above) and its verbatim answer. */
  prompt: { system: string; user: string };
  rawAnswer: string;
  latencyMs: number;
  decidedAt: number;
};

export type EpisodeLog = {
  v: 1;
  type: 'pinky.episode';
  assetId: string;
  device: Address;
  thresholds: Thresholds;
  checkpoint: { id: Hex; payload: Hex; sig: Hex };
  /** The seal evidence record exactly as the device sent it, and the photo when there was one. */
  seal: { record: string; photo?: { mime: string; base64: string } };
  anchor?: { payload: Hex; sig: Hex };
  /** The raw signed readings of the window, in sequence order. */
  readings: Array<{ payload: Hex; sig: Hex }>;
  summary: ReadingSummary;
  /** Attempts that got no decision (0G unreachable or unparseable) before the one below. */
  failedAttempts: Array<{ at: number; error: string }>;
  decision: EpisodeDecision;
  policy: { stateBefore: string; breach: boolean; outcome: string };
};

export function encodeEpisode(log: EpisodeLog): Uint8Array {
  return utf8(JSON.stringify(log));
}

export function decodeEpisode(bytes: Uint8Array): EpisodeLog {
  let parsed: EpisodeLog;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProtocolError('episode log is not valid UTF-8 JSON (wrong key?)');
  }
  if (parsed?.v !== 1 || parsed.type !== 'pinky.episode') throw new ProtocolError('not a version 1 episode log');
  return parsed;
}

/** Decrypts and parses an episode log with the lot's view key. */
export function openEpisode(ciphertext: Uint8Array, viewKey: Hex): EpisodeLog {
  return decodeEpisode(decryptEpisode(ciphertext, fromHex(viewKey, 32)));
}

export function sealEpisode(log: EpisodeLog, viewKey: Hex): Uint8Array {
  return encryptEpisode(encodeEpisode(log), fromHex(viewKey, 32));
}
