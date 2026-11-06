/**
 * The read side: every query the gateway and the buyer page run against Arkiv, in one place.
 *
 * Each query is scoped by creator. A schema tag is public and anyone can write an entity that
 * carries it, so "all readings tagged pinky.reading.v1 for LOT-42" would include forgeries;
 * "all readings for LOT-42 created by the lot's device wallet" does not.
 */
import { and, asc, desc, eq, gte, lte } from '@arkiv-network/sdk/query';
import { addr, u64 } from '@arkiv-network/sdk/schema';
import type { Hex } from '../bytes';
import type { Address } from '../crypto';
import {
  type CheckpointEntity,
  type DeviceEntity,
  type GeoProofEntity,
  type LotEntity,
  type ReadingEntity,
  type VenueEntity,
  parseCheckpoint,
  parseDevice,
  parseGeoProof,
  parseLot,
  parseReading,
  parseVenue,
} from './entities';
import { Checkpoints, Devices, GeoProofs, Lots, Readings, Venues } from './schemas';

/** An Arkiv public client (`createPublicClient` from the SDK). Typed loosely on purpose. */
export type ArkivReader = { select: (...args: any[]) => any };

/** Arkiv returns at most 100 rows per page. */
const PAGE = 100;

/** Runs a query to exhaustion, page by page, up to `max` rows. */
async function all<T>(build: () => any, parse: (row: any) => T, max = 2000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; out.length < max; offset += PAGE) {
    const page = await build().limit(PAGE).offset(offset).fetch();
    for (const row of page.entities) out.push(parse(row));
    if (page.entities.length + (page.skipped ?? 0) < PAGE) break;
  }
  return out.slice(0, max);
}

// --- written by the registry -----------------------------------------------------------------

export function fetchLots(reader: ArkivReader, registry: Address): Promise<LotEntity[]> {
  return all(() => reader.select().from(Lots).createdBy(registry).orderBy(asc('asset_id')), parseLot);
}

export async function fetchLot(
  reader: ArkivReader,
  registry: Address,
  assetId: string,
): Promise<LotEntity | undefined> {
  const lots = await all(
    () => reader.select().from(Lots).where(eq('asset_id', assetId)).createdBy(registry),
    parseLot,
  );
  // Lots are immutable; if the registry ever re-issued one, the newest record wins.
  return lots.sort((a, b) => Number(b.createdAtBlock - a.createdAtBlock))[0];
}

export async function fetchDevice(
  reader: ArkivReader,
  registry: Address,
  deviceId: Address,
): Promise<DeviceEntity | undefined> {
  const devices = await all(
    () =>
      reader
        .select()
        .from(Devices)
        .where(eq('device_id', addr(deviceId)))
        .createdBy(registry),
    parseDevice,
  );
  return devices.sort((a, b) => Number(b.createdAtBlock - a.createdAtBlock))[0];
}

export function fetchVenues(reader: ArkivReader, registry: Address): Promise<VenueEntity[]> {
  return all(() => reader.select().from(Venues).createdBy(registry).orderBy(asc('venue_id')), parseVenue);
}

// --- written by the device -------------------------------------------------------------------

export type ReadingFilter = {
  assetId: string;
  /** The lot's device wallet: only entities it created count. */
  device: Address;
  /** Only readings outside the lot's limits. */
  onlyOutOfRange?: boolean;
  /** Only readings taken at this venue. */
  venueHash?: Hex;
  fromTs?: number;
  toTs?: number;
  max?: number;
};

/**
 * A lot's readings, oldest first. With `onlyOutOfRange` and `venueHash` this is the question
 * from the plan: "all readings for lot #42 at venue Y where in_range = false".
 */
export function fetchReadings(reader: ArkivReader, filter: ReadingFilter): Promise<ReadingEntity[]> {
  const conditions: any[] = [eq('asset_id', filter.assetId)];
  if (filter.onlyOutOfRange) conditions.push(eq('in_range', false));
  if (filter.venueHash) conditions.push(eq('venue_hash', filter.venueHash));
  if (filter.fromTs !== undefined) conditions.push(gte('ts', u64(filter.fromTs)));
  if (filter.toTs !== undefined) conditions.push(lte('ts', u64(filter.toTs)));
  const where = conditions.length === 1 ? conditions[0] : and(...(conditions as [any, any]));
  return all(
    () => reader.select().from(Readings).where(where).createdBy(filter.device).orderBy(asc('seq')),
    parseReading,
    filter.max,
  );
}

/** A lot's checkpoint records, newest first. A checkpoint may have a PENDING and a decided record. */
export function fetchCheckpoints(
  reader: ArkivReader,
  filter: { assetId: string; device: Address },
): Promise<CheckpointEntity[]> {
  return all(
    () =>
      reader
        .select()
        .from(Checkpoints)
        .where(eq('asset_id', filter.assetId))
        .createdBy(filter.device)
        .orderBy(desc('decided_at')),
    parseCheckpoint,
  );
}

/** One record per checkpoint: the decided one when there is one, else the PENDING one. */
export function latestPerCheckpoint(records: CheckpointEntity[]): CheckpointEntity[] {
  const byId = new Map<Hex, CheckpointEntity>();
  for (const record of records) {
    const current = byId.get(record.checkpointId);
    const better =
      !current ||
      (current.decision === 'PENDING' && record.decision !== 'PENDING') ||
      (current.decision === record.decision && record.decidedAt > current.decidedAt);
    if (better) byId.set(record.checkpointId, record);
  }
  return [...byId.values()].sort((a, b) => b.seq - a.seq);
}

// --- written by the gateway ------------------------------------------------------------------

/** A lot's geofence proofs, oldest first. They verify on their own; the creator scope is hygiene. */
export function fetchGeoProofs(
  reader: ArkivReader,
  filter: { assetId: string; gateway: Address },
): Promise<GeoProofEntity[]> {
  return all(
    () =>
      reader
        .select()
        .from(GeoProofs)
        .where(eq('asset_id', filter.assetId))
        .createdBy(filter.gateway)
        .orderBy(asc('seq')),
    parseGeoProof,
  );
}
