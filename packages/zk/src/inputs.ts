/**
 * Maps protocol objects onto the geofence circuit's inputs.
 *
 * The circuit's public inputs are, in order: digest (32 bytes), device public key x (32) and
 * y (32), then lat_min, lat_max, lon_min, lon_max — 100 field elements, each a 32-byte
 * big-endian value. A verifier rebuilds them from data it already trusts (the reading's digest,
 * the device key from its certificate, the venue's published box) rather than accepting them
 * from whoever hands over the proof.
 */
import { type GeoBox, type GpsOpening, ProtocolError, READING_LENGTH, assertGeoBox } from '@pinky/protocol';

export type GeofenceStatement = {
  /** SHA-256 of the reading payload — what the device signed. */
  digest: Uint8Array;
  /** The device wallet's secp256k1 public key, x ‖ y (64 bytes). */
  publicKey: Uint8Array;
  /** The venue's bounding box, in shifted 1e-7 degree units. */
  box: GeoBox;
};

export type GeofenceWitness = {
  /** The 144-byte PPR1 payload. */
  payload: Uint8Array;
  /** The device signature, 65 bytes r ‖ s ‖ v (only r ‖ s is used). */
  signature: Uint8Array;
  opening: GpsOpening;
};

function fieldHex(value: number): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function assertStatement(statement: GeofenceStatement): void {
  if (statement.digest.length !== 32) throw new ProtocolError('geofence digest must be 32 bytes');
  if (statement.publicKey.length !== 64) throw new ProtocolError('geofence public key must be 64 bytes (x ‖ y)');
  assertGeoBox(statement.box);
}

/** The 100 public inputs for a statement, in circuit order. */
export function publicInputsFor(statement: GeofenceStatement): string[] {
  assertStatement(statement);
  const { digest, publicKey, box } = statement;
  return [
    ...Array.from(digest, fieldHex),
    ...Array.from(publicKey, fieldHex),
    fieldHex(box.latMin),
    fieldHex(box.latMax),
    fieldHex(box.lonMin),
    fieldHex(box.lonMax),
  ];
}

/** The input map Noir executes the circuit with. */
export function circuitInputs(statement: GeofenceStatement, witness: GeofenceWitness) {
  assertStatement(statement);
  if (witness.payload.length !== READING_LENGTH) throw new ProtocolError('geofence payload must be 144 bytes');
  if (witness.signature.length !== 65 && witness.signature.length !== 64) {
    throw new ProtocolError('geofence signature must be 64 or 65 bytes');
  }
  if (witness.opening.salt.length !== 32) throw new ProtocolError('geofence salt must be 32 bytes');
  return {
    digest: Array.from(statement.digest),
    pubkey_x: Array.from(statement.publicKey.subarray(0, 32)),
    pubkey_y: Array.from(statement.publicKey.subarray(32, 64)),
    lat_min: statement.box.latMin,
    lat_max: statement.box.latMax,
    lon_min: statement.box.lonMin,
    lon_max: statement.box.lonMax,
    payload: Array.from(witness.payload),
    signature: Array.from(witness.signature.subarray(0, 64)),
    lat: witness.opening.latUnits,
    lon: witness.opening.lonUnits,
    salt: Array.from(witness.opening.salt),
  };
}
