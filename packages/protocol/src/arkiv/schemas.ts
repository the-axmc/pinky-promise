/**
 * The Arkiv data model: six entity types, who writes each, and which fields can be filtered on.
 *
 *   entity      written by       readonly  expires
 *   ----------  ---------------  --------  ------------------------------------------------
 *   Device      registry wallet  yes       chain maximum (~182 days), anyone may extend
 *   Venue       registry wallet  yes       chain maximum, anyone may extend
 *   Lot         registry wallet  yes       shipment end + dispute window
 *   Reading     DEVICE wallet    yes       shipment end + dispute window (all at once)
 *   Checkpoint  DEVICE wallet    yes       dispute window after the checkpoint
 *   GeoProof    gateway wallet   yes       dispute window after the reading
 *
 * Trust comes from who created an entity, never from its schema tag (anyone can copy a tag).
 * Readers scope Device/Venue/Lot by the registry address they trust, Reading/Checkpoint by the
 * lot's device address, and verify the signatures and proofs inside for themselves.
 *
 * Only columns marked `.indexed()` can appear in a filter. Hashes are indexed as lowercase hex
 * strings (the SDK has no bytes32 column type and `bytes` columns cannot be indexed). Column
 * names avoid the query language's reserved words (`key`, `order`, `by`, type names, ...).
 */
import { addr, bool, bytes, defineSchema, i32, str, u64 } from '@arkiv-network/sdk/schema';

/** A device and the certificate chaining its wallet to its hardware key. */
export const Devices = defineSchema('pinky.device.v1', {
  device_id: addr().indexed(),
  /** SHA-256 of the certificate bundle, as hex. */
  hw_cert_hash: str().indexed(),
  /** PPD1 certificate bundle: payload ‖ hardware signature ‖ wallet signature (234 bytes). */
  hw_cert: bytes(),
  /** The chip's serial number, as hex. */
  hw_serial: str().indexed(),
  /** The wallet's secp256k1 public key, x ‖ y — a public input of geofence proofs. */
  wallet_pubkey: bytes(),
  /** Venues the device is enrolled at, comma-separated (Arkiv has no multi-valued attributes). */
  venue_ids: str().indexed(),
  label: str(),
  registered_at: u64().indexed(),
});

/** A place where custody changes hands, with its public geofence. */
export const Venues = defineSchema('pinky.venue.v1', {
  venue_id: str().indexed(),
  /** Binds the id to the box below: SHA-256("PPV1" ‖ id ‖ bounds), as hex. */
  venue_hash: str().indexed(),
  name: str(),
  lat_min: u64(),
  lat_max: u64(),
  lon_min: u64(),
  lon_max: u64(),
  /** Address of the venue's BLE anchor key, when it has one. */
  anchor: addr().indexed().optional(),
});

/** A physical lot, its limits, and where its receipt token lives on Hedera. */
export const Lots = defineSchema('pinky.lot.v1', {
  asset_id: str().indexed(),
  title: str(),
  device_id: addr().indexed(),
  temp_min_c: i32(),
  temp_max_c: i32(),
  rh_min_c: i32(),
  rh_max_c: i32(),
  /** PPL1 lot profile ‖ registry signature: what the device checks before trusting the limits. */
  profile: bytes(),
  hedera_chain_id: i32().indexed(),
  token: addr().indexed(),
  oracle: addr(),
  market: addr().optional(),
  /** The gateway key that relays 0G decisions for this lot. */
  attestor: addr().indexed(),
  /** The gateway wallet that publishes this lot's geofence proofs. */
  gateway: addr().indexed(),
  units: u64(),
  /** Planned end of the shipment, unix seconds. */
  ends_at: u64(),
  dispute_window_s: u64(),
});

/**
 * One sensor reading. Raw temperature and humidity are NOT here: the public record is whether
 * the reading was in range, the digest the device signed and its signature. The raw payload is
 * in the encrypted episode log on 0G Storage that the next checkpoint points to.
 */
export const Readings = defineSchema('pinky.reading.v1', {
  asset_id: str().indexed(),
  device_id: addr().indexed(),
  seq: u64().indexed(),
  /** Device time, unix seconds. */
  ts: u64().indexed(),
  in_range: bool().indexed(),
  /** Present when the reading was taken inside a venue (and a geofence proof exists). */
  venue_hash: str().indexed().optional(),
  /** SHA-256 of the PPR1 payload, as hex. */
  digest: str().indexed(),
  /** The device's signature over the digest (65 bytes). */
  sig: bytes(),
  gps_commitment: str(),
  /** The Arkiv block whose hash the device put in the payload: the reading cannot predate it. */
  anchor_block: u64(),
  anchor_blockhash: str(),
});

/** A custody handoff and the 0G decision about it. */
export const Checkpoints = defineSchema('pinky.checkpoint.v1', {
  asset_id: str().indexed(),
  device_id: addr().indexed(),
  /** SHA-256 of the PPC1 payload, as hex. A PENDING and a decided record share it. */
  checkpoint_id: str().indexed(),
  /** WAREHOUSE_IN | WAREHOUSE_OUT | DOCK_HANDOFF | FINAL_DELIVERY */
  kind: str().indexed(),
  /** What the model said: PENDING | ACCEPT_CUSTODY | REJECT | ESCALATE */
  decision: str().indexed(),
  /** What it meant: PENDING | ACCEPTED | REFUSED | FROZEN | ESCALATED | BLOCKED_BY_BREACH */
  outcome: str().indexed(),
  /** A bundled reading was out of range. */
  breach: bool().indexed(),
  /** The 0G request id of the decision. Absent while PENDING. */
  zg_request_id: str().indexed().optional(),
  zg_model: str().optional(),
  /** On-chain address of the 0G provider that served the request. */
  zg_provider: str().optional(),
  /** The Router's TEE signature check, when it was requested. */
  zg_tee_verified: bool().optional(),
  /** Where the decision came from: "0g-router", or "dev-mock" for the local stand-in. */
  zg_source: str().indexed(),
  /** 0G Storage root of the encrypted episode log. Absent while PENDING. */
  episode_root: str().indexed().optional(),
  /** The model's reason, cut to fit a string attribute; the episode log has it in full. */
  reason: str(),
  seq: u64().indexed(),
  ts: u64().indexed(),
  first_seq: u64(),
  last_seq: u64(),
  venue_hash: str().indexed().optional(),
  /** PPC1 payload (221 bytes) and the device's signature over its digest. */
  payload: bytes(),
  sig: bytes(),
  /** PPX1 decision attestation (110 bytes), who signed it, and the signature. */
  attestation: bytes(),
  attestor: addr().indexed(),
  attestor_sig: bytes(),
  /** PPA1 venue-anchor attestation ‖ signature, when an anchor co-signed. */
  anchor_att: bytes().optional(),
  /** PPR1 payload ‖ signature of the out-of-range reading: a breach discloses its evidence. */
  breach_reading: bytes().optional(),
  decided_at: u64().indexed(),
});

/** A zero-knowledge proof that a reading was taken inside a venue. Anyone can verify it. */
export const GeoProofs = defineSchema('pinky.geoproof.v1', {
  asset_id: str().indexed(),
  device_id: addr().indexed(),
  venue_id: str().indexed(),
  venue_hash: str().indexed(),
  reading_digest: str().indexed(),
  seq: u64().indexed(),
  ts: u64().indexed(),
  /** SHA-256 of the proof bytes, as hex. */
  proof_hash: str().indexed(),
  circuit: str().indexed(),
  /** SHA-256 of the verification key the proof was made for. */
  vk_hash: str().indexed(),
  proof: bytes(),
});

export const SCHEMA_NAMES = {
  device: 'pinky.device.v1',
  venue: 'pinky.venue.v1',
  lot: 'pinky.lot.v1',
  reading: 'pinky.reading.v1',
  checkpoint: 'pinky.checkpoint.v1',
  geoProof: 'pinky.geoproof.v1',
} as const;

/** Every entity is immutable once written. Devices and venues may be kept alive by anyone. */
export const ENTITY_FLAGS = {
  registry: { readonly: true, permissionlessExtension: true },
  evidence: { readonly: true, permissionlessExtension: false },
} as const;
