import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type GeoBox,
  ProtocolError,
  TEST_KEYS,
  buildVectors,
  fromHex,
  gpsCommitment,
  latToUnits,
  secpGenerateSecret,
  secpPublicKey,
  signReading,
  toHex,
  verifyReading,
} from '@pinky/protocol';
import { CIRCUIT_ARTIFACT, compileGeofence } from '../scripts/build-circuit';
import {
  GEOFENCE_VK_HASH,
  type GeofenceProof,
  type GeofenceStatement,
  type GeofenceWitness,
  PUBLIC_INPUT_COUNT,
  destroyBarretenberg,
  proofHash,
  proveGeofence,
  publicInputsFor,
  verifyGeofence,
} from '../src';

const vectors = buildVectors();
const reading = vectors.readings[0]!;
const verified = verifyReading(reading);
const box: GeoBox = vectors.gps.box;
const opening = {
  latUnits: vectors.gps.latUnits,
  lonUnits: vectors.gps.lonUnits,
  salt: fromHex(vectors.gps.salt),
};

const statement: GeofenceStatement = { digest: verified.digest, publicKey: verified.publicKey, box };
const witness: GeofenceWitness = { payload: verified.payload, signature: verified.signature, opening };

describe('geofence circuit', () => {
  let proof: GeofenceProof;

  beforeAll(async () => {
    proof = await proveGeofence(statement, witness);
  }, 120_000);

  afterAll(async () => {
    await destroyBarretenberg();
  });

  it('proves a signed reading taken inside the venue, and the proof verifies', async () => {
    expect(proof.vkHash).toBe(GEOFENCE_VK_HASH);
    expect(proof.proof.length).toBeGreaterThan(4000);
    expect(proof.proof.length).toBeLessThan(20_000);
    expect(await verifyGeofence(statement, proof.proof)).toBe(true);
    expect(proofHash(proof.proof)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('exposes exactly the statement as public inputs — never the position', () => {
    const inputs = publicInputsFor(statement);
    expect(inputs.length).toBe(PUBLIC_INPUT_COUNT);
    expect(BigInt(inputs[96]!)).toBe(BigInt(box.latMin));
    expect(BigInt(inputs[99]!)).toBe(BigInt(box.lonMax));
    const asText = inputs.join('');
    expect(asText).not.toContain(opening.latUnits.toString(16).padStart(8, '0'));
    expect(asText).not.toContain(opening.lonUnits.toString(16).padStart(8, '0'));
  });

  it('does not verify against a different venue box', async () => {
    expect(await verifyGeofence({ ...statement, box: { ...box, latMax: box.latMax + 1 } }, proof.proof)).toBe(false);
  });

  it('does not verify for a different reading', async () => {
    const other = verifyReading(vectors.readings[1]!);
    expect(await verifyGeofence({ ...statement, digest: other.digest }, proof.proof)).toBe(false);
  });

  it('does not verify for a different device key', async () => {
    const stranger = secpPublicKey(secpGenerateSecret());
    expect(await verifyGeofence({ ...statement, publicKey: stranger }, proof.proof)).toBe(false);
  });

  it('does not verify a corrupted proof', async () => {
    const corrupted = proof.proof.slice();
    corrupted[100] ^= 0x01;
    expect(await verifyGeofence(statement, corrupted)).toBe(false);
    expect(await verifyGeofence(statement, new Uint8Array(10))).toBe(false);
  });

  it('cannot prove a position outside the box', async () => {
    const elsewhere: GeoBox = { ...box, latMin: latToUnits(20), latMax: latToUnits(21) };
    await expect(proveGeofence({ ...statement, box: elsewhere }, witness)).rejects.toThrow(ProtocolError);
  });

  it('cannot prove with an opening that does not match the commitment', async () => {
    const wrongSalt = { ...opening, salt: fromHex(`0x${'00'.repeat(32)}`) };
    await expect(proveGeofence(statement, { ...witness, opening: wrongSalt })).rejects.toThrow(ProtocolError);
    const shifted = { ...opening, latUnits: opening.latUnits + 1 };
    await expect(proveGeofence(statement, { ...witness, opening: shifted })).rejects.toThrow(ProtocolError);
  });

  it('cannot prove for a reading the claimed device did not sign', async () => {
    const strangerSecret = secpGenerateSecret();
    const forged = signReading({ ...verified.reading }, strangerSecret); // same bytes, other signer
    await expect(
      proveGeofence(statement, { ...witness, signature: fromHex(forged.sig) }),
    ).rejects.toThrow(ProtocolError);
  });

  it('cannot prove a spoofed position even with a self-made commitment for another reading', async () => {
    // A different (in-box) commitment than the one the device signed over.
    const fake = { latUnits: box.latMin, lonUnits: box.lonMin, salt: opening.salt };
    expect(toHex(gpsCommitment(fake))).not.toBe(vectors.gps.commitment);
    await expect(proveGeofence(statement, { ...witness, opening: fake })).rejects.toThrow(ProtocolError);
  });

  it('uses the device key the test vectors publish', () => {
    expect(toHex(verified.publicKey)).toBe(toHex(secpPublicKey(TEST_KEYS.device)));
  });
});

describe('committed circuit artifacts', () => {
  it('match the circuit source', async () => {
    const committed = JSON.parse(readFileSync(CIRCUIT_ARTIFACT, 'utf8'));
    const fresh = await compileGeofence();
    expect(committed.bytecode, 'run `pnpm --filter @pinky/zk build:circuit`').toBe(fresh.bytecode);
    expect(committed.noir_version).toBe(fresh.noir_version);
  }, 60_000);
});
