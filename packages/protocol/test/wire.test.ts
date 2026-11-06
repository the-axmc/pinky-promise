import { describe, expect, it } from 'vitest';
import {
  ANCHOR_LENGTH,
  ATTESTATION_LENGTH,
  CERT_BUNDLE_LENGTH,
  CHECKPOINT_LENGTH,
  CheckpointKind,
  Decision,
  LOT_PROFILE_LENGTH,
  ProtocolError,
  READING_GPS_OFFSET,
  READING_LENGTH,
  ZERO_32,
  type Checkpoint,
  type Reading,
  boxAround,
  boxContains,
  checkpointDigest,
  decodeCheckpoint,
  decodeReading,
  encodeCheckpoint,
  encodeReading,
  fromHex,
  gpsCommitment,
  issueDeviceCert,
  latToUnits,
  lonToUnits,
  p256GenerateSecret,
  p256PublicKey,
  readingDigest,
  readingsRoot,
  requestIdHash,
  secpAddress,
  secpGenerateSecret,
  secpPublicKey,
  sha256,
  signAnchorAttestation,
  signCheckpoint,
  signDecisionAttestation,
  signLotProfile,
  signReading,
  toHex,
  unitsToLat,
  unitsToLon,
  venueHash,
  verifyAnchorAttestation,
  verifyCheckpoint,
  verifyDecisionAttestation,
  verifyDeviceCert,
  verifyLotProfile,
  verifyReading,
} from '../src';

const deviceSecret = fromHex(`0x${'11'.repeat(32)}`);
const otherSecret = fromHex(`0x${'22'.repeat(32)}`);
const device = secpAddress(deviceSecret);
const salt = fromHex(`0x${'ab'.repeat(32)}`);
const blockhash = `0x${'cd'.repeat(32)}` as const;

const opening = { latUnits: latToUnits(19.076), lonUnits: lonToUnits(72.8777), salt };

function sampleReading(overrides: Partial<Reading> = {}): Reading {
  return {
    device,
    assetId: 'LOT-42',
    tempCenti: 425,
    rhCenti: 4550,
    gpsCommitment: toHex(gpsCommitment(opening)),
    ts: 1_793_966_400,
    seq: 7,
    blockhash,
    ...overrides,
  };
}

describe('reading (PPR1)', () => {
  it('encodes to exactly 144 bytes with the documented layout', () => {
    const payload = encodeReading(sampleReading());
    expect(payload.length).toBe(READING_LENGTH);
    expect(new TextDecoder().decode(payload.subarray(0, 4))).toBe('PPR1');
    expect(toHex(payload.subarray(4, 24))).toBe(device);
    expect(new TextDecoder().decode(payload.subarray(24, 30))).toBe('LOT-42');
    expect(payload.subarray(30, 56).every((byte) => byte === 0)).toBe(true);
    expect(toHex(payload.subarray(READING_GPS_OFFSET, READING_GPS_OFFSET + 32))).toBe(toHex(gpsCommitment(opening)));
  });

  it('round-trips, including a negative temperature', () => {
    const reading = sampleReading({ tempCenti: -1850, rhCenti: 0, seq: 2 ** 40 });
    expect(decodeReading(encodeReading(reading))).toEqual(reading);
  });

  it('verifies a signature made by the named device and exposes its public key', () => {
    const signed = signReading(sampleReading(), deviceSecret);
    const verified = verifyReading(signed);
    expect(verified.reading).toEqual(sampleReading());
    expect(toHex(verified.digest)).toBe(toHex(readingDigest(fromHex(signed.payload))));
    expect(toHex(verified.publicKey)).toBe(toHex(secpPublicKey(deviceSecret)));
  });

  it('is deterministic, so test vectors are stable', () => {
    expect(signReading(sampleReading(), deviceSecret)).toEqual(signReading(sampleReading(), deviceSecret));
  });

  it('rejects a reading signed by a key other than the device it names', () => {
    const signed = signReading(sampleReading(), otherSecret);
    expect(() => verifyReading(signed)).toThrow(ProtocolError);
  });

  it('rejects any change to the signed bytes', () => {
    const signed = signReading(sampleReading(), deviceSecret);
    const tampered = fromHex(signed.payload);
    tampered[59] ^= 0x01; // lowest byte of the temperature
    expect(() => verifyReading({ payload: toHex(tampered), sig: signed.sig })).toThrow(ProtocolError);
  });

  it('rejects a high-s (malleated) signature', () => {
    const signed = signReading(sampleReading(), deviceSecret);
    const sig = fromHex(signed.sig);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(toHex(sig.subarray(32, 64)));
    const flipped = fromHex(`0x${(n - s).toString(16).padStart(64, '0')}`);
    sig.set(flipped, 32);
    sig[64] = sig[64] === 27 ? 28 : 27;
    expect(() => verifyReading({ payload: signed.payload, sig: toHex(sig) })).toThrow(/low-s/);
  });

  it('refuses values that do not fit their field', () => {
    expect(() => encodeReading(sampleReading({ tempCenti: 2 ** 31 }))).toThrow(ProtocolError);
    expect(() => encodeReading(sampleReading({ rhCenti: -1 }))).toThrow(ProtocolError);
    expect(() => encodeReading(sampleReading({ assetId: 'lot 42' }))).toThrow(ProtocolError);
    expect(() => encodeReading(sampleReading({ assetId: 'x'.repeat(33) }))).toThrow(ProtocolError);
    expect(() => encodeReading(sampleReading({ seq: 1.5 }))).toThrow(ProtocolError);
  });

  it('rejects payloads with the wrong magic or length', () => {
    const payload = encodeReading(sampleReading());
    payload[3] = 0x32;
    expect(() => decodeReading(payload)).toThrow(/PPR1/);
    expect(() => decodeReading(payload.subarray(0, 143))).toThrow(/144/);
  });
});

describe('GPS commitment and geofence', () => {
  it('shifts coordinates so they are never negative and round-trips them', () => {
    expect(latToUnits(-90)).toBe(0);
    expect(latToUnits(90)).toBe(1_800_000_000);
    expect(lonToUnits(-180)).toBe(0);
    expect(lonToUnits(180)).toBe(3_600_000_000);
    expect(unitsToLat(latToUnits(19.076))).toBeCloseTo(19.076, 7);
    expect(unitsToLon(lonToUnits(-58.3816))).toBeCloseTo(-58.3816, 7);
    expect(() => latToUnits(90.1)).toThrow(ProtocolError);
  });

  it('commits to position and salt: changing either changes the commitment', () => {
    const base = toHex(gpsCommitment(opening));
    expect(toHex(gpsCommitment({ ...opening, latUnits: opening.latUnits + 1 }))).not.toBe(base);
    expect(toHex(gpsCommitment({ ...opening, salt: fromHex(`0x${'ac'.repeat(32)}`) }))).not.toBe(base);
    expect(gpsCommitment(opening).length).toBe(32);
  });

  it('matches the documented preimage: lat_u ‖ lon_u ‖ salt', () => {
    const preimage = new Uint8Array(40);
    new DataView(preimage.buffer).setUint32(0, opening.latUnits);
    new DataView(preimage.buffer).setUint32(4, opening.lonUnits);
    preimage.set(salt, 8);
    expect(toHex(gpsCommitment(opening))).toBe(toHex(sha256(preimage)));
  });

  it('builds a box around a point that contains it and excludes far points', () => {
    const box = boxAround(19.076, 72.8777, 150);
    expect(boxContains(box, opening.latUnits, opening.lonUnits)).toBe(true);
    expect(boxContains(box, latToUnits(19.086), opening.lonUnits)).toBe(false);
    expect(boxContains(box, opening.latUnits, lonToUnits(72.9))).toBe(false);
  });

  it('binds the venue hash to both the id and the geofence', () => {
    const box = boxAround(19.076, 72.8777, 150);
    const hash = toHex(venueHash('WH-MUM-01', box));
    expect(toHex(venueHash('WH-MUM-02', box))).not.toBe(hash);
    expect(toHex(venueHash('WH-MUM-01', { ...box, latMax: box.latMax + 1 }))).not.toBe(hash);
  });
});

describe('checkpoint (PPC1)', () => {
  const readings = [5, 6, 7].map((seq) => signReading(sampleReading({ seq }), deviceSecret));
  const digests = readings.map((r) => readingDigest(fromHex(r.payload)));

  function sampleCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
    return {
      device,
      assetId: 'LOT-42',
      kind: CheckpointKind.DOCK_HANDOFF,
      ts: 1_793_966_500,
      seq: 8,
      firstSeq: 5,
      lastSeq: 7,
      readingCount: 3,
      readingsRoot: toHex(readingsRoot(digests)),
      sealHash: toHex(sha256(new Uint8Array([1, 2, 3]))),
      anchorDigest: ZERO_32,
      blockhash,
      ...overrides,
    };
  }

  it('encodes to exactly 221 bytes and round-trips', () => {
    const payload = encodeCheckpoint(sampleCheckpoint());
    expect(payload.length).toBe(CHECKPOINT_LENGTH);
    expect(decodeCheckpoint(payload)).toEqual(sampleCheckpoint());
  });

  it('commits to the bundled readings in order', () => {
    expect(toHex(readingsRoot([digests[1]!, digests[0]!, digests[2]!]))).not.toBe(toHex(readingsRoot(digests)));
    expect(() => readingsRoot([])).toThrow(ProtocolError);
  });

  it('verifies the device signature and uses the digest as the checkpoint id', () => {
    const signed = signCheckpoint(sampleCheckpoint(), deviceSecret);
    const verified = verifyCheckpoint(signed);
    expect(toHex(verified.digest)).toBe(toHex(checkpointDigest(fromHex(signed.payload))));
    expect(() => verifyCheckpoint(signCheckpoint(sampleCheckpoint(), otherSecret))).toThrow(ProtocolError);
  });

  it('refuses a checkpoint that does not come after its own readings', () => {
    expect(() => encodeCheckpoint(sampleCheckpoint({ seq: 7 }))).toThrow(ProtocolError);
    expect(() => encodeCheckpoint(sampleCheckpoint({ firstSeq: 8 }))).toThrow(ProtocolError);
    expect(() => encodeCheckpoint(sampleCheckpoint({ readingCount: 0 }))).toThrow(ProtocolError);
    expect(() => encodeCheckpoint(sampleCheckpoint({ kind: 9 as never }))).toThrow(ProtocolError);
  });
});

describe('venue anchor attestation (PPA1)', () => {
  it('round-trips and reports who signed', () => {
    const anchorSecret = fromHex(`0x${'33'.repeat(32)}`);
    const signed = signAnchorAttestation({ venueId: 'WH-MUM-01', device, blockhash, counter: 12 }, anchorSecret);
    expect(fromHex(signed.payload).length).toBe(ANCHOR_LENGTH);
    const verified = verifyAnchorAttestation(signed);
    expect(verified.signer).toBe(secpAddress(anchorSecret));
    expect(verified.attestation).toEqual({ venueId: 'WH-MUM-01', device, blockhash, counter: 12 });
    expect(toHex(verified.digest)).toBe(toHex(sha256(fromHex(signed.payload))));
  });
});

describe('device certificate (PPD1)', () => {
  const hwSecret = fromHex(`0x${'44'.repeat(32)}`);
  const hwSerial = '0x0123456789abcdef01' as const;

  it('binds the wallet to the hardware key with both signatures', () => {
    const bundle = issueDeviceCert({ hwSecret, walletSecret: deviceSecret, hwSerial, issuedAt: 1_793_900_000 });
    expect(fromHex(bundle).length).toBe(CERT_BUNDLE_LENGTH);
    const verified = verifyDeviceCert(bundle);
    expect(verified.cert.device).toBe(device);
    expect(verified.cert.hwPubkey).toBe(toHex(p256PublicKey(hwSecret)));
    expect(verified.cert.hwSerial).toBe(hwSerial);
    expect(toHex(verified.walletPublicKey)).toBe(toHex(secpPublicKey(deviceSecret)));
  });

  it('rejects a certificate whose hardware signature does not match the embedded key', () => {
    const bundle = fromHex(issueDeviceCert({ hwSecret, walletSecret: deviceSecret, hwSerial, issuedAt: 1 }));
    bundle.set(p256PublicKey(p256GenerateSecret()), 24); // swap in another chip's key
    expect(() => verifyDeviceCert(bundle)).toThrow(/hardware key/);
  });

  it('rejects a certificate countersigned by a different wallet', () => {
    const good = fromHex(issueDeviceCert({ hwSecret, walletSecret: deviceSecret, hwSerial, issuedAt: 1 }));
    const other = fromHex(issueDeviceCert({ hwSecret, walletSecret: secpGenerateSecret(), hwSerial, issuedAt: 1 }));
    good.set(other.subarray(105 + 64), 105 + 64); // someone else's wallet signature
    expect(() => verifyDeviceCert(good)).toThrow(ProtocolError);
  });
});

describe('decision attestation (PPX1)', () => {
  const attestorSecret = fromHex(`0x${'55'.repeat(32)}`);
  const attestation = {
    checkpointDigest: `0x${'ee'.repeat(32)}` as const,
    decision: Decision.REJECT,
    breach: true,
    requestIdHash: requestIdHash('0852f405-6c56-40c2-a800-e6fd70785065'),
    episodeRoot: `0x${'0f'.repeat(32)}` as const,
    decidedAt: 1_793_966_600,
  };

  it('round-trips and reports who signed', () => {
    const signed = signDecisionAttestation(attestation, attestorSecret);
    expect(fromHex(signed.payload).length).toBe(ATTESTATION_LENGTH);
    const verified = verifyDecisionAttestation(signed);
    expect(verified.attestation).toEqual(attestation);
    expect(verified.signer).toBe(secpAddress(attestorSecret));
  });

  it('rejects unknown decision codes and flags', () => {
    const payload = fromHex(signDecisionAttestation(attestation, attestorSecret).payload);
    payload[36] = 4;
    expect(() => verifyDecisionAttestation({ payload: toHex(payload), sig: `0x${'00'.repeat(64)}1b` })).toThrow(
      ProtocolError,
    );
  });
});

describe('lot profile (PPL1)', () => {
  const registrySecret = fromHex(`0x${'66'.repeat(32)}`);
  const profile = {
    assetId: 'LOT-42',
    device,
    tempMinCenti: 200,
    tempMaxCenti: 800,
    rhMinCenti: 2000,
    rhMaxCenti: 7000,
    validUntil: 1_800_000_000,
  };

  it('round-trips and reports who signed', () => {
    const signed = signLotProfile(profile, registrySecret);
    expect(fromHex(signed.payload).length).toBe(LOT_PROFILE_LENGTH);
    const verified = verifyLotProfile(signed);
    expect(verified.profile).toEqual(profile);
    expect(verified.signer).toBe(secpAddress(registrySecret));
  });

  it('refuses an inverted band', () => {
    expect(() => signLotProfile({ ...profile, tempMinCenti: 900 }, registrySecret)).toThrow(ProtocolError);
    expect(() => signLotProfile({ ...profile, rhMaxCenti: 10_001 }, registrySecret)).toThrow(ProtocolError);
  });
});

describe('seal evidence', () => {
  const photo = { sha256: toHex(sha256(new Uint8Array([9, 9, 9]))), mime: 'image/jpeg', source: 'device-camera' as const };

  it('round-trips a record and commits to the exact bytes', async () => {
    const { decodeSealEvidence, encodeSealEvidence, sealHash } = await import('../src');
    const record = encodeSealEvidence({ v: 1, photo, nfc: { uid: '0x04a1b2c3d4e5f6', tamper: 'closed', counter: 12 } });
    expect(decodeSealEvidence(record)).toEqual({ v: 1, photo, nfc: { uid: '0x04a1b2c3d4e5f6', tamper: 'closed', counter: 12 } });
    expect(sealHash(record)).toBe(toHex(sha256(record)));
  });

  it('accepts any one kind of evidence on its own, and refuses none', async () => {
    const { encodeSealEvidence } = await import('../src');
    expect(() => encodeSealEvidence({ v: 1, photo })).not.toThrow();
    expect(() => encodeSealEvidence({ v: 1, nfc: { uid: '0x04a1b2c3' } })).not.toThrow();
    expect(() => encodeSealEvidence({ v: 1, enclosure: { closed: true } })).not.toThrow();
    expect(() => encodeSealEvidence({ v: 1 })).toThrow(ProtocolError);
  });

  it('reports tampering the hardware itself detected', async () => {
    const { sealReportsTamper } = await import('../src');
    expect(sealReportsTamper({ v: 1, nfc: { uid: '0x04', tamper: 'open' } })).toBe(true);
    expect(sealReportsTamper({ v: 1, enclosure: { closed: false } })).toBe(true);
    expect(sealReportsTamper({ v: 1, photo, nfc: { uid: '0x04', tamper: 'closed' }, enclosure: { closed: true } })).toBe(false);
    expect(sealReportsTamper({ v: 1, photo })).toBe(false);
  });

  it('rejects malformed records', async () => {
    const { decodeSealEvidence } = await import('../src');
    const bad = (value: unknown) => () => decodeSealEvidence(new TextEncoder().encode(JSON.stringify(value)));
    expect(bad({ v: 2, photo })).toThrow(ProtocolError);
    expect(bad({ v: 1, photo: { ...photo, sha256: '0x12' } })).toThrow(ProtocolError);
    expect(bad({ v: 1, photo: { ...photo, mime: 'text/html' } })).toThrow(ProtocolError);
    expect(bad({ v: 1, nfc: { uid: 'not hex' } })).toThrow(ProtocolError);
    expect(() => decodeSealEvidence(new Uint8Array([0xff, 0xfe]))).toThrow(ProtocolError);
  });
});

describe('GPS without a fix', () => {
  it('commits to a sentinel that no valid geofence can contain', async () => {
    const { GPS_NO_FIX, LAT_MAX_UNITS, LON_MAX_UNITS, isNoFix, noFixOpening } = await import('../src');
    const opening = noFixOpening(salt);
    expect(isNoFix(opening)).toBe(true);
    expect(gpsCommitment(opening).length).toBe(32);
    expect(GPS_NO_FIX).toBeGreaterThan(LAT_MAX_UNITS);
    expect(GPS_NO_FIX).toBeGreaterThan(LON_MAX_UNITS);
    const world = { latMin: 0, latMax: LAT_MAX_UNITS, lonMin: 0, lonMax: LON_MAX_UNITS };
    expect(boxContains(world, opening.latUnits, opening.lonUnits)).toBe(false);
    // Only the exact sentinel pair is accepted; a single out-of-range coordinate is still an error.
    expect(() => gpsCommitment({ ...opening, lonUnits: 5 })).toThrow(ProtocolError);
  });
});
