import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decryptFile } from '@0gfoundation/0g-storage-ts-sdk';
import { type MockZgRouter, startMockZgRouter } from '@pinky/devnet';
import { buildVectors, decodeReading, encryptEpisode, fromHex, generateViewKey, summarizeReadings } from '@pinky/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DecisionInput, ZgDecisionClient, ZgUnavailable, buildUserPrompt, parseDecision } from '../src/zg/decision';
import { LocalEpisodeStore, zgMerkleRoot } from '../src/zg/storage';

const vectors = buildVectors();
const readings = vectors.readings.map((r) => decodeReading(fromHex(r.payload)));
const seals = resolve(import.meta.dirname, '../../device/assets');
const photo = (condition: 'intact' | 'broken') => ({
  mime: 'image/png',
  bytes: new Uint8Array(readFileSync(join(seals, `seal-${condition}.png`))),
});

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    assetId: 'LOT-42',
    kind: 'DOCK_HANDOFF',
    state: 'IN_TRANSIT',
    summary: summarizeReadings(readings.slice(0, 2), vectors.lot.thresholds), // both in range
    seal: { v: 1, photo: { sha256: `0x${'ab'.repeat(32)}`, mime: 'image/png', source: 'simulated' } },
    photo: photo('intact'),
    anchor: { present: true, venueId: 'DK-PNQ-02' },
    geofence: { proven: true, venueId: 'DK-PNQ-02' },
    ...overrides,
  };
}

let router: MockZgRouter;
let client: ZgDecisionClient;

beforeAll(async () => {
  router = await startMockZgRouter();
});
afterAll(async () => {
  await router.stop();
});
beforeEach(() => {
  router.setMode('up');
  client = new ZgDecisionClient({ mode: 'mock', baseUrl: router.baseUrl, apiKey: 'sk-test', model: 'mock-vision' });
});

describe('decision parsing', () => {
  it('reads a decision out of plain JSON, fenced JSON and surrounding prose', () => {
    const answer = '{"decision":"REJECT","seal":"broken","reason":"The seal is torn."}';
    expect(parseDecision(answer)).toEqual({ decision: 'REJECT', reason: 'The seal is torn.' });
    expect(parseDecision('```json\n' + answer + '\n```')).toMatchObject({ decision: 'REJECT' });
    expect(parseDecision(`Here is my answer: ${answer} Hope that helps.`)).toMatchObject({ decision: 'REJECT' });
    expect(parseDecision('{"decision":"accept_custody","reason":"ok"}')).toMatchObject({ decision: 'ACCEPT_CUSTODY' });
  });

  it('finds no decision in anything else', () => {
    for (const text of [
      '',
      'Looks fine to me.',
      '{"decision":"MAYBE","reason":"x"}',
      '{"decision":"REJECT"}',
      '{"decision":"REJECT","reason":"   "}',
      '{"verdict":"REJECT","reason":"x"}',
      '{not json}',
      '[]',
    ]) {
      expect(parseDecision(text), text).toBeUndefined();
    }
  });
});

describe('the prompt', () => {
  it('gives the model the signed facts and never the raw position', () => {
    const prompt = buildUserPrompt(input({ summary: summarizeReadings(readings, vectors.lot.thresholds) }));
    const handoff = JSON.parse(prompt.slice(prompt.indexOf('{')));
    expect(handoff).toMatchObject({
      lot: 'LOT-42',
      handoff: 'DOCK_HANDOFF',
      custody_state_before: 'IN_TRANSIT',
      readings: { count: 5, out_of_range: 3, temperature_c: { min: -1.5, max: 12.6 }, limits: { tempMinC: 2, tempMaxC: 8 } },
      seal: { photo_attached: true, hardware_reports_tamper: false },
      location: { venue_anchor_cosigned: true, geofence_proven: true, venue: 'DK-PNQ-02' },
    });
    expect(prompt).not.toMatch(/lat|lon/i);
  });
});

describe('ZgDecisionClient against an OpenAI-compatible endpoint', () => {
  it('passes a preflight that checks the model takes images', async () => {
    expect(await client.preflight()).toEqual({ ok: true, problems: [], acceptsImages: true, jsonMode: true });
    const wrongModel = new ZgDecisionClient({ ...client.config, model: 'no-such-model' });
    expect(await wrongModel.preflight()).toMatchObject({ ok: false, problems: [expect.stringMatching(/not in the 0G catalog/)] });
    const dead = new ZgDecisionClient({ ...client.config, baseUrl: 'http://127.0.0.1:9/v1' });
    expect(await dead.preflight()).toMatchObject({ ok: false, problems: [expect.stringMatching(/unreachable/)] });
  });

  it('returns a decision with its request id, and marks where it came from', async () => {
    const result = await client.decide(input());
    expect(result).toMatchObject({ decision: 'ACCEPT_CUSTODY', source: 'dev-mock', model: 'mock-vision' });
    expect(result.requestId).toMatch(/^mock-[0-9a-f-]{36}$/);
    expect(result.reason.length).toBeGreaterThan(10);
    expect(result.prompt.user).toContain('"lot": "LOT-42"');
    expect(router.requests.at(-1)).toMatchObject({ hasImage: true, decision: 'ACCEPT_CUSTODY' });
  });

  it('rejects on a broken seal, on out-of-range readings and on hardware tamper', async () => {
    expect((await client.decide(input({ photo: photo('broken') }))).decision).toBe('REJECT');
    const breached = summarizeReadings(readings, vectors.lot.thresholds);
    expect((await client.decide(input({ summary: breached }))).decision).toBe('REJECT');
    const tampered = input({ seal: { v: 1, nfc: { uid: '0x04a1b2c3', tamper: 'open' } }, photo: undefined });
    expect((await client.decide(tampered)).decision).toBe('REJECT');
  });

  it('escalates when the photo is not a recognisable seal', async () => {
    const noise = { mime: 'image/png', bytes: new Uint8Array(64).fill(7) };
    expect((await client.decide(input({ photo: noise }))).decision).toBe('ESCALATE');
  });

  it('decides on hardware seal evidence alone when the board has no camera', async () => {
    const nfcOnly = input({ seal: { v: 1, nfc: { uid: '0x04a1b2c3', tamper: 'closed' } }, photo: undefined });
    expect((await client.decide(nfcOnly)).decision).toBe('ACCEPT_CUSTODY');
    expect(router.requests.at(-1)?.hasImage).toBe(false);
  });
});

describe('safe stop: no decision is ever invented', () => {
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as ZgUnavailable;
    }
    throw new Error('expected ZgUnavailable');
  };

  it('throws "unreachable" when nothing answers', async () => {
    const dead = new ZgDecisionClient({ ...client.config, baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 2000 });
    const error = await failure(dead.decide(input()));
    expect(error).toBeInstanceOf(ZgUnavailable);
    expect(error.kind).toBe('unreachable');
  });

  it('throws "unreachable" when the Router has no healthy provider (503)', async () => {
    router.setMode('down');
    const error = await failure(client.decide(input()));
    expect(error.kind).toBe('unreachable');
    expect(error.message).toMatch(/no_available_provider/);
    expect(error.requestId).toMatch(/^mock-/);
  });

  it('throws "refused" when the account has no balance (402)', async () => {
    router.setMode('no-balance');
    const error = await failure(client.decide(input()));
    expect(error.kind).toBe('refused');
    expect(error.message).toMatch(/insufficient_balance/);
  });

  it('throws "undecided" when the model answers without a decision', async () => {
    router.setMode('garbage');
    const error = await failure(client.decide(input()));
    expect(error.kind).toBe('undecided');
    expect(error.requestId).toMatch(/^mock-/);
  });

  it('throws "refused" without an API key', async () => {
    const anonymous = new ZgDecisionClient({ ...client.config, apiKey: '' });
    expect((await failure(anonymous.decide(input()))).kind).toBe('refused');
  });

  it('refuses a stand-in answer when the gateway is in router mode', async () => {
    const strict = new ZgDecisionClient({ ...client.config, mode: 'router' });
    const error = await failure(strict.decide(input()));
    expect(error.kind).toBe('untrusted');
    expect(error.message).toMatch(/stand-in/);
  });

  it('refuses an answer that fails TEE verification when verification is required', async () => {
    const verifying = new ZgDecisionClient({ ...client.config, verifyTee: true });
    const error = await failure(verifying.decide(input()));
    expect(error.kind).toBe('untrusted');
    expect(error.message).toMatch(/TEE verification/);
  });
});

describe('episode storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pinky-episodes-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('stores and returns bytes by their 0G Merkle root', async () => {
    const store = new LocalEpisodeStore(directory);
    const bytes = new TextEncoder().encode('episode log bytes '.repeat(100));
    const stored = await store.put(bytes);
    expect(stored.root).toBe(await zgMerkleRoot(bytes));
    expect(stored.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await store.get(stored.root)).toEqual(bytes);
    expect((await store.put(new Uint8Array([1, 2, 3]))).root).not.toBe(stored.root);
    await expect(store.get(`0x${'00'.repeat(32)}`)).rejects.toThrow(/not in the local store/);
  });

  it('encrypts in the format the 0G Storage SDK itself decrypts', () => {
    const key = fromHex(generateViewKey());
    const plaintext = new TextEncoder().encode(JSON.stringify({ readings: readings.length, note: 'raw values' }));
    expect(decryptFile(key, encryptEpisode(plaintext, key))).toEqual(plaintext);
  });
});
