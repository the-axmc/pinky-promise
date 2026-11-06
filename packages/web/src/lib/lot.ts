/**
 * Everything the page shows about one lot, gathered from the networks themselves: the lot,
 * device and venues, readings, custody records and geofence proofs from Arkiv; custody state
 * and token figures from Hedera. Each item carries the result of its own checks.
 */
import { type Address, type Hex, LotState, type LotStateValue, assetIdToBytes32, fromHex } from '@pinky/protocol';
import {
  type CheckpointEntity,
  type DeviceEntity,
  type GeoProofEntity,
  type LotEntity,
  type ReadingEntity,
  type VenueEntity,
  fetchCheckpoints,
  fetchDevice,
  fetchGeoProofs,
  fetchLot,
  fetchLots,
  fetchReadings,
  fetchVenues,
  latestPerCheckpoint,
} from '@pinky/protocol/arkiv';
import { atsTokenAbi, custodyOracleAbi } from '@pinky/protocol/hedera';
import type { Context } from './config';
import { type Check, type DisclosedReading, checkCheckpoint, checkDevice, checkLot, checkProofRecord, checkReading, disclosedBreach } from './verify';

export type LotStateName = keyof typeof LotState;
export const lotStateName = (value: number): LotStateName =>
  (Object.entries(LotState).find(([, v]) => v === value)?.[0] ?? 'NONE') as LotStateName;

export type OnChain = {
  state: LotStateName;
  breachOpen: boolean;
  token: Address;
  totalSupply: bigint;
  /** Whether the oracle names the same device and attestor as the Arkiv lot record. */
  agreesWithArkiv: boolean;
};

export type ReadingView = ReadingEntity & { checks: Check[]; venue?: VenueEntity; proof?: GeoProofEntity };
export type CheckpointView = CheckpointEntity & { checks: Check[]; venue?: VenueEntity; disclosed?: DisclosedReading };
export type ProofView = GeoProofEntity & { checks: Check[]; venue?: VenueEntity };

export type LotView = {
  lot: LotEntity;
  lotChecks: Check[];
  device?: DeviceEntity;
  deviceChecks: Check[];
  venues: VenueEntity[];
  onChain?: OnChain;
  readings: ReadingView[];
  checkpoints: CheckpointView[];
  proofs: ProofView[];
  /** When this snapshot was read. */
  at: number;
};

export function listLots(ctx: Context): Promise<LotEntity[]> {
  return fetchLots(ctx.arkiv, ctx.config.arkiv.registry);
}

export async function readOnChain(ctx: Context, lot: LotEntity): Promise<OnChain | undefined> {
  const record = await ctx.hedera.readContract({
    address: ctx.config.hedera.oracle,
    abi: custodyOracleAbi,
    functionName: 'getLot',
    args: [assetIdToBytes32(lot.assetId)],
  });
  if (record.state === 0) return undefined;
  const token = record.token.toLowerCase() as Address;
  const totalSupply = await ctx.hedera.readContract({ address: token, abi: atsTokenAbi, functionName: 'totalSupply' });
  return {
    state: lotStateName(record.state as LotStateValue),
    breachOpen: record.breachOpen,
    token,
    totalSupply,
    agreesWithArkiv:
      token === lot.token.toLowerCase() &&
      record.device.toLowerCase() === lot.deviceId.toLowerCase() &&
      record.attestor.toLowerCase() === lot.attestor.toLowerCase(),
  };
}

export async function loadLot(ctx: Context, assetId: string, vkHash: Hex): Promise<LotView | undefined> {
  const registry = ctx.config.arkiv.registry;
  const lot = await fetchLot(ctx.arkiv, registry, assetId);
  if (!lot) return undefined;

  const [device, venues, readings, checkpointRecords, proofs, onChain] = await Promise.all([
    fetchDevice(ctx.arkiv, registry, lot.deviceId),
    fetchVenues(ctx.arkiv, registry),
    fetchReadings(ctx.arkiv, { assetId, device: lot.deviceId }),
    fetchCheckpoints(ctx.arkiv, { assetId, device: lot.deviceId }),
    fetchGeoProofs(ctx.arkiv, { assetId, gateway: lot.gateway }),
    readOnChain(ctx, lot).catch(() => undefined),
  ]);

  const venueByHash = new Map(venues.map((venue) => [venue.venueHash, venue]));
  const proofByReading = new Map(proofs.map((proof) => [proof.readingDigest, proof]));

  return {
    lot,
    lotChecks: checkLot(lot, registry),
    ...(device ? { device } : {}),
    deviceChecks: checkDevice(device, lot, registry),
    venues,
    ...(onChain ? { onChain } : {}),
    readings: readings
      .sort((a, b) => a.seq - b.seq)
      .map((reading) => {
        const venue = reading.venueHash ? venueByHash.get(reading.venueHash) : undefined;
        const proof = proofByReading.get(reading.digest);
        return { ...reading, checks: checkReading(reading, lot), ...(venue ? { venue } : {}), ...(proof ? { proof } : {}) };
      }),
    checkpoints: latestPerCheckpoint(checkpointRecords)
      .sort((a, b) => a.seq - b.seq)
      .map((record) => {
        const venue = record.venueHash ? venueByHash.get(record.venueHash) : undefined;
        const disclosed = disclosedBreach(record, lot);
        return { ...record, checks: checkCheckpoint(record, lot, venues, readings), ...(venue ? { venue } : {}), ...(disclosed ? { disclosed } : {}) };
      }),
    proofs: proofs
      .sort((a, b) => a.seq - b.seq)
      .map((proof) => {
        const venue = venueByHash.get(proof.venueHash);
        return { ...proof, checks: checkProofRecord(proof, lot.gateway, vkHash), ...(venue ? { venue } : {}) };
      }),
    at: Date.now(),
  };
}

/**
 * Runs the zero-knowledge verifier on one proof. The statement is rebuilt from public data the
 * page already checked — the reading's digest, the device's public key from its certificate
 * record, and the venue's box — so a proof made for anything else fails.
 */
export async function verifyProof(view: LotView, proof: GeoProofEntity): Promise<boolean> {
  if (!view.device) return false;
  const venue = view.venues.find((candidate) => candidate.venueHash === proof.venueHash);
  if (!venue) return false;
  const { verifyGeofence } = await import('@pinky/zk/verify');
  return verifyGeofence(
    { digest: fromHex(proof.readingDigest, 32), publicKey: fromHex(view.device.walletPubkey, 64), box: venue.box },
    fromHex(proof.proof),
    { threads: 1 },
  );
}
