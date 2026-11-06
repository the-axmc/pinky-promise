/**
 * How long each kind of entity lives. Expiry is data minimisation: evidence stays exactly as
 * long as somebody could still dispute the shipment, then the chain drops it.
 *
 * Arkiv counts lifetimes in 2-second blocks and caps them at 7,884,000 blocks (about 182.5
 * days), so "never" in the plan becomes "the maximum, and anyone may extend it".
 */
import { ExpirationTime } from '@arkiv-network/sdk';

export const ARKIV_BLOCK_TIME_S = 2;
export const ARKIV_MAX_LIFETIME_S = 7_884_000 * ARKIV_BLOCK_TIME_S;
/** Nothing is written with less than this, so a write cannot be dead on arrival. */
export const MIN_LIFETIME_S = 120;

/** Clamps to the chain's bounds and rounds up to a whole number of blocks. */
export function lifetimeSeconds(seconds: number): number {
  const clamped = Math.min(Math.max(Math.ceil(seconds), MIN_LIFETIME_S), ARKIV_MAX_LIFETIME_S);
  return clamped + (clamped % ARKIV_BLOCK_TIME_S);
}

/** Devices and venues: the longest the chain allows. Renew with `extendEntity` before it runs out. */
export function registryExpiration() {
  return ExpirationTime.max();
}

/**
 * Lots and their readings: until the shipment's planned end plus the dispute window. Because
 * the deadline is absolute, every reading of a lot expires at the same moment however late in
 * the journey it was written.
 */
export function shipmentExpiration(
  lot: { endsAt: number; disputeWindowS: number },
  nowS = Date.now() / 1000,
) {
  return ExpirationTime.fromSeconds(lifetimeSeconds(lot.endsAt + lot.disputeWindowS - nowS));
}

/** Checkpoints and geofence proofs: one dispute window from the moment they are written. */
export function evidenceExpiration(disputeWindowS: number) {
  return ExpirationTime.fromSeconds(lifetimeSeconds(disputeWindowS));
}
