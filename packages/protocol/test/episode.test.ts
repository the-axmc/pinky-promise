import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ProtocolError,
  buildVectors,
  decodeReading,
  decryptEpisode,
  encryptEpisode,
  fromHex,
  generateViewKey,
  openEpisode,
  sealEpisode,
  summarizeReadings,
  toHex,
  type EpisodeLog,
} from '../src';

const vectors = buildVectors();
const readings = vectors.readings.map((r) => decodeReading(fromHex(r.payload)));
const thresholds = vectors.lot.thresholds;

describe('reading summary', () => {
  it('reports the facts the decision model is given', () => {
    expect(summarizeReadings(readings, thresholds)).toEqual({
      count: 5,
      firstSeq: 5,
      lastSeq: 9,
      missingSeqs: 0,
      spanSeconds: 120,
      tempMinC: -1.5,
      tempMaxC: 12.6,
      tempMeanC: 4.32,
      rhMinPct: 20,
      rhMaxPct: 91,
      limits: { tempMinC: 2, tempMaxC: 8, rhMinPct: 20, rhMaxPct: 70 },
      outOfRange: 3,
      worstTempExcursionC: 4.6,
    });
  });

  it('counts readings the gateway never received', () => {
    const gappy = [readings[0]!, readings[2]!, readings[4]!];
    expect(summarizeReadings(gappy, thresholds)).toMatchObject({ count: 3, missingSeqs: 2 });
  });

  it('is zero-excursion when everything is in range, and refuses an empty window', () => {
    expect(summarizeReadings(readings.slice(0, 2), thresholds)).toMatchObject({
      outOfRange: 0,
      worstTempExcursionC: 0,
    });
    expect(() => summarizeReadings([], thresholds)).toThrow(ProtocolError);
  });
});

describe('episode encryption', () => {
  const key = fromHex(generateViewKey());
  const plaintext = new TextEncoder().encode('raw readings stay private until someone holds the view key');

  it('round-trips', () => {
    expect(decryptEpisode(encryptEpisode(plaintext, key), key)).toEqual(plaintext);
  });

  it('uses the 0G Storage symmetric format: 0x01, a 16-byte nonce, then AES-256-CTR', () => {
    const nonce = fromHex(`0x${'a5'.repeat(16)}`);
    const ciphertext = encryptEpisode(plaintext, key, nonce);
    expect(ciphertext[0]).toBe(1);
    expect(toHex(ciphertext.subarray(1, 17))).toBe(toHex(nonce));
    // Cross-check against an independent AES-CTR implementation.
    const reference = createCipheriv('aes-256-ctr', key, nonce).update(plaintext);
    expect(toHex(ciphertext.subarray(17))).toBe(toHex(new Uint8Array(reference)));
  });

  it('does not decrypt to the same bytes with another key', () => {
    const other = fromHex(generateViewKey());
    expect(decryptEpisode(encryptEpisode(plaintext, key), other)).not.toEqual(plaintext);
    expect(() => decryptEpisode(new Uint8Array([2, 0, 0]), key)).toThrow(ProtocolError);
  });

  it('seals and opens a whole episode, and fails clearly with the wrong key', () => {
    const viewKey = generateViewKey();
    const log: EpisodeLog = {
      v: 1,
      type: 'pinky.episode',
      assetId: 'LOT-42',
      device: vectors.keys.device.address,
      thresholds,
      checkpoint: {
        id: vectors.checkpoint.digest,
        payload: vectors.checkpoint.payload,
        sig: vectors.checkpoint.sig,
      },
      seal: { record: vectors.seal.text },
      readings: vectors.readings.map(({ payload, sig }) => ({ payload, sig })),
      summary: summarizeReadings(readings, thresholds),
      failedAttempts: [{ at: 1_793_966_810, error: '0G unreachable: connect ECONNREFUSED' }],
      decision: {
        source: 'dev-mock',
        requestId: vectors.attestation.requestId,
        model: 'mock-vision',
        decision: 'REJECT',
        reason: 'Three readings were outside the 2–8 °C band.',
        prompt: { system: 'You decide custody handoffs.', user: '{"readings":{}}' },
        rawAnswer: '{"decision":"REJECT"}',
        latencyMs: 412,
        decidedAt: 1_793_966_830,
      },
      policy: { stateBefore: 'IN_TRANSIT', breach: true, outcome: 'FROZEN' },
    };
    const sealed = sealEpisode(log, viewKey);
    expect(openEpisode(sealed, viewKey)).toEqual(log);
    expect(() => openEpisode(sealed, generateViewKey())).toThrow(/wrong key/);
  });
});
