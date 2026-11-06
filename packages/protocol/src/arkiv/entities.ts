/**
 * Both directions between protocol objects and Arkiv entities:
 *
 *   xxxValues(...)   builds the values for `walletClient.createEntity(Schema, values, ...)`.
 *   parseXxx(row)    turns a query row back into a plain object.
 *
 * Every value goes through the SDK's typed constructors (`str(...)`, `u64(...)`, ...) so its
 * type is explicit; the device relies on that to compare a transaction it is asked to sign
 * against what these same functions produce from its own measurements.
 */
import { addr, bool, bytes, i32, str, u64 } from '@arkiv-network/sdk/schema';
import { type Hex, ProtocolError, concat, fromHex, toHex, utf8 } from '../bytes';
import { type Address, normalizeAddress, sha256 } from '../crypto';
import { type Venue, venueHashHex } from '../gps';
import { type Reading } from '../reading';
import { type Checkpoint, type CheckpointKindName, checkpointKindName } from '../checkpoint';
import { verifyDeviceCert } from '../cert';
import { type DecisionAttestation, type DecisionName, decisionName } from '../attestation';
import { type LotProfile, type SignedLotProfile, type Thresholds, verifyLotProfile } from '../lot';
import { type OutcomeName } from '../policy';

/** Arkiv string attributes hold at most 128 bytes of UTF-8. */
export const ARKIV_MAX_STRING_BYTES = 128;

/** Cuts text to fit a string attribute without splitting a multi-byte character. */
export function fitString(text: string, maxBytes = ARKIV_MAX_STRING_BYTES): string {
  if (utf8(text).length <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = utf8(char).length;
    if (used + size > maxBytes - 3) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

/** What every entity carries besides its attributes. */
export type EntityMeta = {
  entityKey: Hex;
  /** The wallet that created the entity — the one fact a reader can build trust on. */
  creator: Address;
  owner: Address;
  createdAtBlock: bigint;
  expiresAtBlock: bigint;
  readonly: boolean;
};

type Row = Record<string, any>;

function meta(row: Row): EntityMeta {
  return {
    entityKey: row.$key,
    creator: normalizeAddress(row.$creator),
    owner: normalizeAddress(row.$owner),
    createdAtBlock: BigInt(row.$createdAt),
    expiresAtBlock: BigInt(row.$expiresAt),
    readonly: Boolean(row.$creationFlags?.readonly),
  };
}

const value = <T>(cell: { value: T } | undefined): T | undefined => cell?.value;
const required = <T>(row: Row, name: string): T => {
  const cell = row[name];
  if (cell === undefined || cell === null) throw new ProtocolError(`Arkiv entity is missing "${name}"`);
  return cell.value as T;
};
const num = (row: Row, name: string): number => Number(required<bigint>(row, name));
const hex = (row: Row, name: string): Hex => required<string>(row, name).toLowerCase() as Hex;
const optHex = (row: Row, name: string): Hex | undefined => value<string>(row[name])?.toLowerCase() as Hex | undefined;

// ---------------------------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------------------------

export type DeviceEntity = EntityMeta & {
  deviceId: Address;
  hwCert: Hex;
  hwCertHash: Hex;
  hwSerial: Hex;
  walletPubkey: Hex;
  venueIds: string[];
  label: string;
  registeredAt: number;
};

/** Verifies the certificate bundle and builds the Device entity from what it proves. */
export function deviceValues(input: { certBundle: Hex; venueIds: string[]; label: string; registeredAt: number }) {
  const { cert, walletPublicKey } = verifyDeviceCert(input.certBundle);
  return {
    device_id: addr(cert.device),
    hw_cert_hash: str(toHex(sha256(fromHex(input.certBundle)))),
    hw_cert: bytes(input.certBundle),
    hw_serial: str(cert.hwSerial),
    wallet_pubkey: bytes(toHex(walletPublicKey)),
    venue_ids: str(input.venueIds.join(',')),
    label: str(fitString(input.label)),
    registered_at: u64(input.registeredAt),
  };
}

export function parseDevice(row: Row): DeviceEntity {
  return {
    ...meta(row),
    deviceId: normalizeAddress(required<string>(row, 'device_id')),
    hwCert: hex(row, 'hw_cert'),
    hwCertHash: hex(row, 'hw_cert_hash'),
    hwSerial: hex(row, 'hw_serial'),
    walletPubkey: hex(row, 'wallet_pubkey'),
    venueIds: required<string>(row, 'venue_ids').split(',').filter(Boolean),
    label: required<string>(row, 'label'),
    registeredAt: num(row, 'registered_at'),
  };
}

// ---------------------------------------------------------------------------------------------
// Venue
// ---------------------------------------------------------------------------------------------

export type VenueEntity = EntityMeta & Venue & { venueHash: Hex };

export function venueValues(venue: Venue) {
  return {
    venue_id: str(venue.venueId),
    venue_hash: str(venueHashHex(venue)),
    name: str(fitString(venue.name)),
    lat_min: u64(venue.box.latMin),
    lat_max: u64(venue.box.latMax),
    lon_min: u64(venue.box.lonMin),
    lon_max: u64(venue.box.lonMax),
    ...(venue.anchor ? { anchor: addr(venue.anchor) } : {}),
  };
}

export function parseVenue(row: Row): VenueEntity {
  const anchor = value<string>(row.anchor);
  return {
    ...meta(row),
    venueId: required<string>(row, 'venue_id'),
    venueHash: hex(row, 'venue_hash'),
    name: required<string>(row, 'name'),
    box: {
      latMin: num(row, 'lat_min'),
      latMax: num(row, 'lat_max'),
      lonMin: num(row, 'lon_min'),
      lonMax: num(row, 'lon_max'),
    },
    ...(anchor ? { anchor: normalizeAddress(anchor) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Lot
// ---------------------------------------------------------------------------------------------

export type LotInput = {
  title: string;
  /** The registry-signed PPL1 profile: lot id, device, limits. */
  signedProfile: SignedLotProfile;
  hederaChainId: number;
  token: Address;
  oracle: Address;
  market?: Address;
  attestor: Address;
  gateway: Address;
  units: number;
  endsAt: number;
  disputeWindowS: number;
};

export type LotEntity = EntityMeta &
  Thresholds & {
    assetId: string;
    title: string;
    deviceId: Address;
    profile: LotProfile;
    signedProfile: SignedLotProfile;
    /** Who signed the profile; a reader checks it is the registry it trusts. */
    profileSigner: Address;
    hederaChainId: number;
    token: Address;
    oracle: Address;
    market?: Address;
    attestor: Address;
    gateway: Address;
    units: number;
    endsAt: number;
    disputeWindowS: number;
  };

export function lotValues(input: LotInput) {
  const { profile } = verifyLotProfile(input.signedProfile);
  return {
    asset_id: str(profile.assetId),
    title: str(fitString(input.title)),
    device_id: addr(profile.device),
    temp_min_c: i32(profile.tempMinCenti),
    temp_max_c: i32(profile.tempMaxCenti),
    rh_min_c: i32(profile.rhMinCenti),
    rh_max_c: i32(profile.rhMaxCenti),
    profile: bytes(toHex(concat(fromHex(input.signedProfile.payload), fromHex(input.signedProfile.sig)))),
    hedera_chain_id: i32(input.hederaChainId),
    token: addr(input.token),
    oracle: addr(input.oracle),
    ...(input.market ? { market: addr(input.market) } : {}),
    attestor: addr(input.attestor),
    gateway: addr(input.gateway),
    units: u64(input.units),
    ends_at: u64(input.endsAt),
    dispute_window_s: u64(input.disputeWindowS),
  };
}

export function parseLot(row: Row): LotEntity {
  const packed = fromHex(hex(row, 'profile'));
  const signedProfile = { payload: toHex(packed.subarray(0, 80)), sig: toHex(packed.subarray(80)) };
  const { profile, signer } = verifyLotProfile(signedProfile);
  const market = value<string>(row.market);
  return {
    ...meta(row),
    assetId: required<string>(row, 'asset_id'),
    title: required<string>(row, 'title'),
    deviceId: normalizeAddress(required<string>(row, 'device_id')),
    tempMinCenti: required<number>(row, 'temp_min_c'),
    tempMaxCenti: required<number>(row, 'temp_max_c'),
    rhMinCenti: required<number>(row, 'rh_min_c'),
    rhMaxCenti: required<number>(row, 'rh_max_c'),
    profile,
    signedProfile,
    profileSigner: signer,
    hederaChainId: required<number>(row, 'hedera_chain_id'),
    token: normalizeAddress(required<string>(row, 'token')),
    oracle: normalizeAddress(required<string>(row, 'oracle')),
    ...(market ? { market: normalizeAddress(market) } : {}),
    attestor: normalizeAddress(required<string>(row, 'attestor')),
    gateway: normalizeAddress(required<string>(row, 'gateway')),
    units: num(row, 'units'),
    endsAt: num(row, 'ends_at'),
    disputeWindowS: num(row, 'dispute_window_s'),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export type ReadingInput = {
  reading: Reading;
  digest: Hex;
  sig: Hex;
  inRange: boolean;
  /** Set when the reading was matched to a venue's geofence. */
  venueHash?: Hex;
  /** Number of the Arkiv block whose hash is in the payload. */
  anchorBlock: number;
};

export type ReadingEntity = EntityMeta & {
  assetId: string;
  deviceId: Address;
  seq: number;
  ts: number;
  inRange: boolean;
  venueHash?: Hex;
  digest: Hex;
  sig: Hex;
  gpsCommitment: Hex;
  anchorBlock: number;
  anchorBlockhash: Hex;
};

export function readingValues(input: ReadingInput) {
  const { reading } = input;
  return {
    asset_id: str(reading.assetId),
    device_id: addr(reading.device),
    seq: u64(reading.seq),
    ts: u64(reading.ts),
    in_range: bool(input.inRange),
    ...(input.venueHash ? { venue_hash: str(input.venueHash) } : {}),
    digest: str(input.digest),
    sig: bytes(input.sig),
    gps_commitment: str(reading.gpsCommitment),
    anchor_block: u64(input.anchorBlock),
    anchor_blockhash: str(reading.blockhash),
  };
}

export function parseReading(row: Row): ReadingEntity {
  const venueHash = optHex(row, 'venue_hash');
  return {
    ...meta(row),
    assetId: required<string>(row, 'asset_id'),
    deviceId: normalizeAddress(required<string>(row, 'device_id')),
    seq: num(row, 'seq'),
    ts: num(row, 'ts'),
    inRange: required<boolean>(row, 'in_range'),
    ...(venueHash ? { venueHash } : {}),
    digest: hex(row, 'digest'),
    sig: hex(row, 'sig'),
    gpsCommitment: hex(row, 'gps_commitment'),
    anchorBlock: num(row, 'anchor_block'),
    anchorBlockhash: hex(row, 'anchor_blockhash'),
  };
}

// ---------------------------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------------------------

/** How a decision reached us. "dev-mock" marks the local stand-in so it is never mistaken for 0G. */
export type ZgSource = '0g-router' | 'dev-mock' | 'none';

export type CheckpointInput = {
  checkpoint: Checkpoint;
  checkpointId: Hex;
  payload: Hex;
  sig: Hex;
  outcome: OutcomeName | 'PENDING';
  reason: string;
  attestation: DecisionAttestation;
  attestationPayload: Hex;
  attestor: Address;
  attestorSig: Hex;
  zg: { source: ZgSource; requestId?: string; model?: string; provider?: string; teeVerified?: boolean };
  venueHash?: Hex;
  /** PPA1 payload ‖ signature. */
  anchorAttestation?: Hex;
  /** PPR1 payload ‖ signature of the reading that proves the breach. */
  breachReading?: Hex;
};

export type CheckpointEntity = EntityMeta & {
  assetId: string;
  deviceId: Address;
  checkpointId: Hex;
  kind: CheckpointKindName;
  decision: DecisionName;
  outcome: OutcomeName | 'PENDING';
  breach: boolean;
  zgRequestId?: string;
  zgModel?: string;
  zgProvider?: string;
  zgTeeVerified?: boolean;
  zgSource: ZgSource;
  episodeRoot?: Hex;
  reason: string;
  seq: number;
  ts: number;
  firstSeq: number;
  lastSeq: number;
  venueHash?: Hex;
  payload: Hex;
  sig: Hex;
  attestation: Hex;
  attestor: Address;
  attestorSig: Hex;
  anchorAttestation?: Hex;
  breachReading?: Hex;
  decidedAt: number;
};

const ZERO_HASH = `0x${'00'.repeat(32)}`;

export function checkpointValues(input: CheckpointInput) {
  const { checkpoint, attestation, zg } = input;
  const decided = attestation.decision !== 0;
  return {
    asset_id: str(checkpoint.assetId),
    device_id: addr(checkpoint.device),
    checkpoint_id: str(input.checkpointId),
    kind: str(checkpointKindName(checkpoint.kind)),
    decision: str(decisionName(attestation.decision)),
    outcome: str(input.outcome),
    breach: bool(attestation.breach),
    ...(zg.requestId ? { zg_request_id: str(fitString(zg.requestId)) } : {}),
    ...(zg.model ? { zg_model: str(fitString(zg.model)) } : {}),
    ...(zg.provider ? { zg_provider: str(fitString(zg.provider)) } : {}),
    ...(zg.teeVerified !== undefined ? { zg_tee_verified: bool(zg.teeVerified) } : {}),
    zg_source: str(zg.source),
    ...(decided && attestation.episodeRoot !== ZERO_HASH ? { episode_root: str(attestation.episodeRoot) } : {}),
    reason: str(fitString(input.reason)),
    seq: u64(checkpoint.seq),
    ts: u64(checkpoint.ts),
    first_seq: u64(checkpoint.firstSeq),
    last_seq: u64(checkpoint.lastSeq),
    ...(input.venueHash ? { venue_hash: str(input.venueHash) } : {}),
    payload: bytes(input.payload),
    sig: bytes(input.sig),
    attestation: bytes(input.attestationPayload),
    attestor: addr(input.attestor),
    attestor_sig: bytes(input.attestorSig),
    ...(input.anchorAttestation ? { anchor_att: bytes(input.anchorAttestation) } : {}),
    ...(input.breachReading ? { breach_reading: bytes(input.breachReading) } : {}),
    decided_at: u64(attestation.decidedAt),
  };
}

export function parseCheckpoint(row: Row): CheckpointEntity {
  const optional = {
    zgRequestId: value<string>(row.zg_request_id),
    zgModel: value<string>(row.zg_model),
    zgProvider: value<string>(row.zg_provider),
    zgTeeVerified: value<boolean>(row.zg_tee_verified),
    episodeRoot: optHex(row, 'episode_root'),
    venueHash: optHex(row, 'venue_hash'),
    anchorAttestation: optHex(row, 'anchor_att'),
    breachReading: optHex(row, 'breach_reading'),
  };
  return {
    ...meta(row),
    assetId: required<string>(row, 'asset_id'),
    deviceId: normalizeAddress(required<string>(row, 'device_id')),
    checkpointId: hex(row, 'checkpoint_id'),
    kind: required<CheckpointKindName>(row, 'kind'),
    decision: required<DecisionName>(row, 'decision'),
    outcome: required<OutcomeName | 'PENDING'>(row, 'outcome'),
    breach: required<boolean>(row, 'breach'),
    zgSource: required<ZgSource>(row, 'zg_source'),
    reason: required<string>(row, 'reason'),
    seq: num(row, 'seq'),
    ts: num(row, 'ts'),
    firstSeq: num(row, 'first_seq'),
    lastSeq: num(row, 'last_seq'),
    payload: hex(row, 'payload'),
    sig: hex(row, 'sig'),
    attestation: hex(row, 'attestation'),
    attestor: normalizeAddress(required<string>(row, 'attestor')),
    attestorSig: hex(row, 'attestor_sig'),
    decidedAt: num(row, 'decided_at'),
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}

// ---------------------------------------------------------------------------------------------
// GeoProof
// ---------------------------------------------------------------------------------------------

export type GeoProofInput = {
  assetId: string;
  deviceId: Address;
  venueId: string;
  venueHash: Hex;
  readingDigest: Hex;
  seq: number;
  ts: number;
  proofHash: Hex;
  circuit: string;
  vkHash: Hex;
  proof: Uint8Array;
};

export type GeoProofEntity = EntityMeta & Omit<GeoProofInput, 'proof'> & { proof: Hex };

export function geoProofValues(input: GeoProofInput) {
  return {
    asset_id: str(input.assetId),
    device_id: addr(input.deviceId),
    venue_id: str(input.venueId),
    venue_hash: str(input.venueHash),
    reading_digest: str(input.readingDigest),
    seq: u64(input.seq),
    ts: u64(input.ts),
    proof_hash: str(input.proofHash),
    circuit: str(input.circuit),
    vk_hash: str(input.vkHash),
    proof: bytes(input.proof),
  };
}

export function parseGeoProof(row: Row): GeoProofEntity {
  return {
    ...meta(row),
    assetId: required<string>(row, 'asset_id'),
    deviceId: normalizeAddress(required<string>(row, 'device_id')),
    venueId: required<string>(row, 'venue_id'),
    venueHash: hex(row, 'venue_hash'),
    readingDigest: hex(row, 'reading_digest'),
    seq: num(row, 'seq'),
    ts: num(row, 'ts'),
    proofHash: hex(row, 'proof_hash'),
    circuit: required<string>(row, 'circuit'),
    vkHash: hex(row, 'vk_hash'),
    proof: hex(row, 'proof'),
  };
}
