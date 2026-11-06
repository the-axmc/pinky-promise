/**
 * Every check the buyer page makes, as plain functions over public data. None of them asks the
 * gateway anything: they recompute hashes and recover signers from what is on Arkiv, and compare
 * against the registry, the device and the attestor the lot names.
 */
import {
  type Address,
  type Hex,
  fromHex,
  isInRange,
  readingsRoot,
  requestIdHash,
  sameAddress,
  secpVerify,
  sha256,
  toHex,
  verifyAnchorAttestation,
  verifyCheckpoint,
  verifyDecisionAttestation,
  verifyDeviceCert,
  verifyReading,
} from '@pinky/protocol';
import type { CheckpointEntity, DeviceEntity, GeoProofEntity, LotEntity, ReadingEntity, VenueEntity } from '@pinky/protocol/arkiv';

export type Check = { ok: boolean; label: string; detail?: string };

const attempt = (label: string, run: () => true | string): Check => {
  try {
    const result = run();
    return result === true ? { ok: true, label } : { ok: false, label, detail: result };
  } catch (error) {
    return { ok: false, label, detail: (error as Error).message };
  }
};

/** Is the lot record what the registry published, with limits the registry signed? */
export function checkLot(lot: LotEntity, registry: Address): Check[] {
  return [
    attempt('Lot record was created by the registry', () => sameAddress(lot.creator, registry) || `created by ${lot.creator}`),
    attempt('Limits and device are signed by the registry', () => sameAddress(lot.profileSigner, registry) || `signed by ${lot.profileSigner}`),
    attempt('Record is read-only (it cannot be edited later)', () => lot.readonly || 'the entity is not read-only'),
  ];
}

/** Is the device the one the registry enrolled, with a certificate tying it to its hardware key? */
export function checkDevice(device: DeviceEntity | undefined, lot: LotEntity, registry: Address): Check[] {
  if (!device) return [{ ok: false, label: 'Device is enrolled on Arkiv', detail: `no Device entity for ${lot.deviceId}` }];
  return [
    attempt('Device was enrolled by the registry', () => sameAddress(device.creator, registry) || `created by ${device.creator}`),
    attempt('Certificate binds the wallet to the secure element', () => {
      const { cert } = verifyDeviceCert(device.hwCert);
      if (!sameAddress(cert.device, lot.deviceId)) return `certificate is for ${cert.device}`;
      if (toHex(sha256(fromHex(device.hwCert))) !== device.hwCertHash) return 'certificate hash does not match';
      return true;
    }),
  ];
}

/** A reading counts only if the device wallet created the entity and signed the digest. */
export function checkReading(reading: ReadingEntity, lot: LotEntity): Check[] {
  return [
    attempt('Written by the device wallet', () => sameAddress(reading.creator, lot.deviceId) || `created by ${reading.creator}`),
    attempt('Signed by the device', () => secpVerify(fromHex(reading.digest, 32), fromHex(reading.sig, 65), lot.deviceId) || 'signature does not match the device'),
  ];
}

export type DisclosedReading = { tempCenti: number; rhCenti: number; seq: number; ts: number };

/** The out-of-range reading a breach record discloses, once verified. */
export function disclosedBreach(record: CheckpointEntity, lot: LotEntity): DisclosedReading | undefined {
  if (!record.breachReading) return undefined;
  try {
    const evidence = fromHex(record.breachReading);
    const { reading } = verifyReading({ payload: toHex(evidence.subarray(0, 144)), sig: toHex(evidence.subarray(144)) });
    if (!sameAddress(reading.device, lot.deviceId)) return undefined;
    return { tempCenti: reading.tempCenti, rhCenti: reading.rhCenti, seq: reading.seq, ts: reading.ts };
  } catch {
    return undefined;
  }
}

/** Is a custody record signed by the device, and its decision attested by the lot's attestor? */
export function checkCheckpoint(record: CheckpointEntity, lot: LotEntity, venues: VenueEntity[], readings: ReadingEntity[] = []): Check[] {
  const checks: Check[] = [
    attempt('Written by the device wallet', () => sameAddress(record.creator, lot.deviceId) || `created by ${record.creator}`),
    attempt('Checkpoint signed by the device', () => {
      const { checkpoint, digest } = verifyCheckpoint({ payload: record.payload, sig: record.sig });
      if (!sameAddress(checkpoint.device, lot.deviceId)) return `signed by ${checkpoint.device}`;
      if (toHex(digest) !== record.checkpointId) return 'payload does not hash to the checkpoint id';
      if (checkpoint.assetId !== lot.assetId) return `checkpoint is for ${checkpoint.assetId}`;
      return true;
    }),
  ];
  if (record.decision === 'PENDING') {
    checks.push({ ok: true, label: 'No decision yet — nothing is accepted', detail: record.reason });
    return checks;
  }
  checks.push(
    attempt("Decision attested by the lot's attestor", () => {
      const { attestation, signer } = verifyDecisionAttestation({ payload: record.attestation, sig: record.attestorSig });
      if (!sameAddress(signer, lot.attestor)) return `attested by ${signer}, the lot names ${lot.attestor}`;
      if (attestation.checkpointDigest !== record.checkpointId) return 'attestation is for another checkpoint';
      if (attestation.breach !== record.breach) return 'attestation and record disagree about the breach';
      if (record.zgRequestId && attestation.requestIdHash !== requestIdHash(record.zgRequestId)) return 'request id does not match the attested hash';
      if (record.episodeRoot && attestation.episodeRoot !== record.episodeRoot) return 'episode root does not match the attested one';
      return true;
    }),
  );
  checks.push(
    // The checkpoint commits to the readings it was judged on. If one of them was never
    // published, the count is short or the hashes do not add up: withholding shows.
    attempt('Every reading it was judged on is published', () => {
      const { checkpoint } = verifyCheckpoint({ payload: record.payload, sig: record.sig });
      const window = readings.filter((reading) => reading.seq >= checkpoint.firstSeq && reading.seq <= checkpoint.lastSeq).sort((x, y) => x.seq - y.seq);
      if (window.length !== checkpoint.readingCount) return `${window.length} of ${checkpoint.readingCount} readings are on Arkiv`;
      const root = toHex(readingsRoot(window.map((reading) => fromHex(reading.digest, 32))));
      return root === checkpoint.readingsRoot || 'the published readings do not hash to what the device committed to';
    }),
  );
  if (record.breach) {
    checks.push(
      attempt('Breach is backed by a device-signed out-of-range reading', () => {
        const disclosed = disclosedBreach(record, lot);
        if (!disclosed) return 'no verifiable reading was disclosed';
        return !isInRange(lot, disclosed.tempCenti, disclosed.rhCenti) || 'the disclosed reading is within limits';
      }),
    );
  }
  if (record.anchorAttestation) {
    checks.push(
      attempt("Venue anchor co-signed (the device was in the venue's radio range)", () => {
        const raw = fromHex(record.anchorAttestation!);
        const { attestation, signer } = verifyAnchorAttestation({ payload: toHex(raw.subarray(0, 96)), sig: toHex(raw.subarray(96)) });
        const venue = venues.find((candidate) => candidate.venueId === attestation.venueId);
        if (!venue?.anchor) return `venue ${attestation.venueId} has no registered anchor`;
        if (!sameAddress(signer, venue.anchor)) return `signed by ${signer}, not the anchor of ${venue.venueId}`;
        if (!sameAddress(attestation.device, lot.deviceId)) return 'the anchor signed for another device';
        return true;
      }),
    );
  } else {
    checks.push({ ok: false, label: 'No venue anchor co-signed this handoff', detail: 'location rests on GPS alone, which can be spoofed' });
  }
  return checks;
}

/** Everything about a geofence proof that can be checked without running the verifier. */
export function checkProofRecord(proof: GeoProofEntity, gateway: Address, vkHash: Hex): Check[] {
  return [
    attempt('Published by the gateway', () => sameAddress(proof.creator, gateway) || `created by ${proof.creator}`),
    attempt('Proof bytes match the recorded hash', () => toHex(sha256(fromHex(proof.proof))) === proof.proofHash || 'hash mismatch'),
    attempt('Made for the circuit this page verifies', () => proof.vkHash === vkHash || `circuit key ${proof.vkHash}`),
  ];
}

export const allOk = (checks: Check[]) => checks.every((check) => check.ok);

