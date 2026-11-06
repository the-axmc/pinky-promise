/**
 * Deterministic test vectors for the wire formats and the state machine.
 *
 * They are the contract between implementations: the TypeScript in this package produces them,
 * the Solidity tests check the Hedera contract parses and decides identically, and firmware can
 * be validated against them before any hardware talks to a gateway.
 *
 * Every key below is a published test key. Never fund or reuse them.
 */
import { type Hex, fromHex, toHex } from './bytes';
import { p256PublicKey, secpAddress, secpPublicKey, sha256 } from './crypto';
import { boxAround, gpsCommitment, latToUnits, lonToUnits, venueHash } from './gps';
import { type Reading, readingDigest, signReading } from './reading';
import { CheckpointKind, ZERO_32, checkpointDigest, readingsRoot, signCheckpoint } from './checkpoint';
import { encodeSealEvidence, sealHash } from './seal';
import { signAnchorAttestation } from './anchor';
import { issueDeviceCert } from './cert';
import { Decision, requestIdHash, signDecisionAttestation } from './attestation';
import { assetIdToBytes32, isInRange, isinForLot, signLotProfile } from './lot';
import { LotState, applyCheckpoint } from './policy';

const secret = (byte: string) => fromHex(`0x${byte.repeat(32)}`);

export const TEST_KEYS = {
  device: secret('11'),
  attestor: secret('55'),
  anchor: secret('33'),
  registry: secret('66'),
  hardware: secret('44'),
};

export function buildVectors() {
  const device = secpAddress(TEST_KEYS.device);
  const assetId = 'LOT-42';
  const thresholds = { tempMinCenti: 200, tempMaxCenti: 800, rhMinCenti: 2000, rhMaxCenti: 7000 };
  const blockhash: Hex = `0x${'cd'.repeat(32)}`;
  const venue = { venueId: 'WH-MUM-01', box: boxAround(19.076, 72.8777, 150) };
  const opening = { latUnits: latToUnits(19.0761), lonUnits: lonToUnits(72.8778), salt: secret('ab') };
  const commitment = toHex(gpsCommitment(opening));

  const readingFields: Array<{ name: string; fields: Reading }> = [
    { name: 'in range', fields: reading(5, 425, 4550) },
    { name: 'in range, lower bounds exactly', fields: reading(6, 200, 2000) },
    { name: 'too warm', fields: reading(7, 1260, 4550) },
    { name: 'too cold (negative)', fields: reading(8, -150, 4550) },
    { name: 'too humid', fields: reading(9, 425, 9100) },
  ];
  function reading(seq: number, tempCenti: number, rhCenti: number): Reading {
    return {
      device,
      assetId,
      tempCenti,
      rhCenti,
      gpsCommitment: commitment,
      ts: 1_793_966_400 + seq * 30,
      seq,
      blockhash,
    };
  }
  const readings = readingFields.map(({ name, fields }) => {
    const signed = signReading(fields, TEST_KEYS.device);
    return {
      name,
      fields,
      inRange: isInRange(thresholds, fields.tempCenti, fields.rhCenti),
      payload: signed.payload,
      digest: toHex(readingDigest(fromHex(signed.payload))),
      sig: signed.sig,
    };
  });

  const anchor = signAnchorAttestation(
    { venueId: venue.venueId, device, blockhash, counter: 12 },
    TEST_KEYS.anchor,
  );
  // A seal evidence record with a photo and an NFC seal tag whose tamper loop is intact.
  const sealRecord = encodeSealEvidence({
    v: 1,
    photo: {
      sha256: toHex(sha256(new TextEncoder().encode('seal photo bytes'))),
      mime: 'image/jpeg',
      source: 'simulated',
    },
    nfc: { uid: '0x04a1b2c3d4e5f6', tagType: 'NTAG213 TT', tamper: 'closed' },
  });
  const checkpointFields = {
    device,
    assetId,
    kind: CheckpointKind.DOCK_HANDOFF,
    ts: 1_793_966_800,
    seq: 10,
    firstSeq: 5,
    lastSeq: 9,
    readingCount: readings.length,
    readingsRoot: toHex(readingsRoot(readings.map((r) => fromHex(r.digest)))),
    sealHash: sealHash(sealRecord),
    anchorDigest: toHex(sha256(fromHex(anchor.payload))),
    blockhash,
  };
  const checkpoint = signCheckpoint(checkpointFields, TEST_KEYS.device);
  const checkpointId = toHex(checkpointDigest(fromHex(checkpoint.payload)));

  const requestId = '0852f405-6c56-40c2-a800-e6fd70785065';
  const attestationFields = {
    checkpointDigest: checkpointId,
    decision: Decision.REJECT,
    breach: true,
    requestIdHash: requestIdHash(requestId),
    episodeRoot: `0x${'0f'.repeat(32)}` as Hex,
    decidedAt: 1_793_966_830,
  };
  const attestation = signDecisionAttestation(attestationFields, TEST_KEYS.attestor);

  const profileFields = { assetId, device, ...thresholds, validUntil: 1_800_000_000 };
  const lotProfile = signLotProfile(profileFields, TEST_KEYS.registry);

  const hwSerial: Hex = '0x0123456789abcdef01';
  const cert = issueDeviceCert({
    hwSecret: TEST_KEYS.hardware,
    walletSecret: TEST_KEYS.device,
    hwSerial,
    issuedAt: 1_793_900_000,
  });

  // The whole policy table: every state x breach flag x kind x decision x evidence flag.
  const policy = [];
  for (const state of Object.values(LotState)) {
    for (const breachOpen of [false, true]) {
      for (const kind of Object.values(CheckpointKind)) {
        for (const decision of Object.values(Decision)) {
          for (const breachProven of [false, true]) {
            const result = applyCheckpoint({ state, breachOpen, kind, decision, breachProven });
            policy.push({
              state,
              breachOpen,
              kind,
              decision,
              breachProven,
              ok: result.ok,
              outcome: result.ok ? result.outcome : 0,
              next: result.ok ? result.next : state,
              breachOpenAfter: result.ok ? result.breachOpen : breachOpen,
            });
          }
        }
      }
    }
  }

  return {
    description:
      'Test vectors for the Pinky Promise wire formats (v1). All keys are published test keys: never fund or reuse them.',
    keys: {
      device: {
        secret: toHex(TEST_KEYS.device),
        address: device,
        publicKey: toHex(secpPublicKey(TEST_KEYS.device)),
      },
      attestor: { secret: toHex(TEST_KEYS.attestor), address: secpAddress(TEST_KEYS.attestor) },
      anchor: { secret: toHex(TEST_KEYS.anchor), address: secpAddress(TEST_KEYS.anchor) },
      registry: { secret: toHex(TEST_KEYS.registry), address: secpAddress(TEST_KEYS.registry) },
      hardware: { secret: toHex(TEST_KEYS.hardware), publicKey: toHex(p256PublicKey(TEST_KEYS.hardware)) },
    },
    lot: { assetId, assetIdBytes32: assetIdToBytes32(assetId), isin: isinForLot(assetId), thresholds },
    gps: {
      latUnits: opening.latUnits,
      lonUnits: opening.lonUnits,
      salt: toHex(opening.salt),
      commitment,
      venueId: venue.venueId,
      box: venue.box,
      venueHash: toHex(venueHash(venue.venueId, venue.box)),
    },
    readings,
    anchor: {
      fields: { venueId: venue.venueId, device, blockhash, counter: 12 },
      ...anchor,
      digest: checkpointFields.anchorDigest,
    },
    seal: {
      record: toHex(sealRecord),
      text: new TextDecoder().decode(sealRecord),
      hash: sealHash(sealRecord),
    },
    checkpoint: { fields: checkpointFields, ...checkpoint, digest: checkpointId },
    attestation: {
      requestId,
      fields: attestationFields,
      ...attestation,
      digest: toHex(sha256(fromHex(attestation.payload))),
    },
    lotProfile: { fields: profileFields, ...lotProfile },
    cert: { hwSerial, issuedAt: 1_793_900_000, bundle: cert },
    zero32: ZERO_32,
    policy,
  };
}

export type Vectors = ReturnType<typeof buildVectors>;
