import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VECTORS_FILE, renderVectors } from '../scripts/generate-vectors';
import {
  buildVectors,
  fromHex,
  verifyAnchorAttestation,
  verifyCheckpoint,
  verifyDecisionAttestation,
  verifyDeviceCert,
  verifyLotProfile,
  verifyReading,
} from '../src';

describe('test vectors', () => {
  const vectors = buildVectors();

  it('are internally consistent: every signature verifies against its named signer', () => {
    for (const reading of vectors.readings) {
      expect(verifyReading(reading).reading.device).toBe(vectors.keys.device.address);
    }
    expect(verifyCheckpoint(vectors.checkpoint).checkpoint.device).toBe(vectors.keys.device.address);
    expect(verifyAnchorAttestation(vectors.anchor).signer).toBe(vectors.keys.anchor.address);
    expect(verifyDecisionAttestation(vectors.attestation).signer).toBe(vectors.keys.attestor.address);
    expect(verifyLotProfile(vectors.lotProfile).signer).toBe(vectors.keys.registry.address);
    expect(verifyDeviceCert(vectors.cert.bundle).cert.device).toBe(vectors.keys.device.address);
  });

  it('cover both sides of the breach boundary', () => {
    expect(vectors.readings.filter((r) => r.inRange).length).toBeGreaterThanOrEqual(2);
    expect(vectors.readings.filter((r) => !r.inRange).length).toBeGreaterThanOrEqual(3);
  });

  it('enumerate the whole policy table', () => {
    // 6 states x 2 breach flags x 4 kinds x 4 decisions x 2 evidence flags
    expect(vectors.policy.length).toBe(6 * 2 * 4 * 4 * 2);
  });

  it('link the checkpoint to its readings and its anchor', () => {
    expect(vectors.checkpoint.fields.anchorDigest).toBe(vectors.anchor.digest);
    expect(fromHex(vectors.attestation.fields.checkpointDigest)).toEqual(fromHex(vectors.checkpoint.digest));
  });

  it('match the file committed for the Solidity tests', () => {
    expect(existsSync(VECTORS_FILE), 'run `pnpm --filter @pinky/protocol vectors`').toBe(true);
    expect(readFileSync(VECTORS_FILE, 'utf8')).toBe(renderVectors());
  });
});
