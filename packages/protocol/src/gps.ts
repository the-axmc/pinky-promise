/**
 * GPS never leaves the device in the clear. A reading carries a commitment to the position, and
 * the gateway later proves in zero knowledge that the committed point lies inside a venue's
 * bounding box.
 *
 * Coordinates are integers in units of 1e-7 degree (what a u-blox receiver reports), shifted so
 * they are never negative:
 *
 *   lat_u = round(lat_deg * 1e7) +   900_000_000     range 0 .. 1_800_000_000
 *   lon_u = round(lon_deg * 1e7) + 1_800_000_000     range 0 .. 3_600_000_000
 *
 * Both fit a u32, which keeps the circuit's range checks to plain unsigned comparisons.
 *
 *   commitment = SHA-256( lat_u (4) ‖ lon_u (4) ‖ salt (32) )      40-byte preimage
 *
 * A device without a GPS module, or without a fix (indoors is the normal case in a warehouse),
 * commits to the pair (0xFFFFFFFF, 0xFFFFFFFF). That value lies outside every valid box, so "no
 * position" can never be proven to be inside a venue; presence then rests on the venue anchor.
 */
import { type Hex, ProtocolError, asciiFixed, concat, toHex, u32be, utf8 } from './bytes';
import { sha256 } from './crypto';

export const LAT_OFFSET = 900_000_000;
export const LON_OFFSET = 1_800_000_000;
export const LAT_MAX_UNITS = 1_800_000_000;
export const LON_MAX_UNITS = 3_600_000_000;
/** Both coordinates set to this mean "no position": no GPS module, or no fix. */
export const GPS_NO_FIX = 0xffff_ffff;

export function latToUnits(degrees: number): number {
  if (!Number.isFinite(degrees) || degrees < -90 || degrees > 90) {
    throw new ProtocolError(`latitude out of range: ${degrees}`);
  }
  return Math.round(degrees * 1e7) + LAT_OFFSET;
}

export function lonToUnits(degrees: number): number {
  if (!Number.isFinite(degrees) || degrees < -180 || degrees > 180) {
    throw new ProtocolError(`longitude out of range: ${degrees}`);
  }
  return Math.round(degrees * 1e7) + LON_OFFSET;
}

export function unitsToLat(units: number): number {
  return (units - LAT_OFFSET) / 1e7;
}

export function unitsToLon(units: number): number {
  return (units - LON_OFFSET) / 1e7;
}

/** The private opening of a GPS commitment. Shared with the gateway only, never published. */
export type GpsOpening = { latUnits: number; lonUnits: number; salt: Uint8Array };

/** The opening a device commits to when it has no position. */
export function noFixOpening(salt: Uint8Array): GpsOpening {
  return { latUnits: GPS_NO_FIX, lonUnits: GPS_NO_FIX, salt };
}

export function isNoFix(opening: Pick<GpsOpening, 'latUnits' | 'lonUnits'>): boolean {
  return opening.latUnits === GPS_NO_FIX && opening.lonUnits === GPS_NO_FIX;
}

export function gpsCommitment(opening: GpsOpening): Uint8Array {
  const { latUnits, lonUnits, salt } = opening;
  if (salt.length !== 32) throw new ProtocolError('GPS salt must be 32 bytes');
  if (!isNoFix(opening)) {
    if (!Number.isInteger(latUnits) || latUnits < 0 || latUnits > LAT_MAX_UNITS) {
      throw new ProtocolError(`latitude units out of range: ${latUnits}`);
    }
    if (!Number.isInteger(lonUnits) || lonUnits < 0 || lonUnits > LON_MAX_UNITS) {
      throw new ProtocolError(`longitude units out of range: ${lonUnits}`);
    }
  }
  return sha256(concat(u32be(latUnits), u32be(lonUnits), salt));
}

/** An axis-aligned bounding box in shifted units, bounds inclusive. */
export type GeoBox = { latMin: number; latMax: number; lonMin: number; lonMax: number };

export function assertGeoBox(box: GeoBox): void {
  const { latMin, latMax, lonMin, lonMax } = box;
  for (const value of [latMin, latMax, lonMin, lonMax]) {
    if (!Number.isInteger(value) || value < 0)
      throw new ProtocolError('geofence bounds must be non-negative integers');
  }
  if (latMin > latMax || latMax > LAT_MAX_UNITS)
    throw new ProtocolError('geofence latitude bounds are invalid');
  if (lonMin > lonMax || lonMax > LON_MAX_UNITS)
    throw new ProtocolError('geofence longitude bounds are invalid');
}

export function boxContains(box: GeoBox, latUnits: number, lonUnits: number): boolean {
  return latUnits >= box.latMin && latUnits <= box.latMax && lonUnits >= box.lonMin && lonUnits <= box.lonMax;
}

/** A box of roughly `radiusMeters` around a point — a convenient way to define a venue. */
export function boxAround(latDegrees: number, lonDegrees: number, radiusMeters: number): GeoBox {
  const latDelta = radiusMeters / 111_320;
  const lonDelta = radiusMeters / (111_320 * Math.max(Math.cos((latDegrees * Math.PI) / 180), 0.01));
  const box = {
    latMin: latToUnits(Math.max(latDegrees - latDelta, -90)),
    latMax: latToUnits(Math.min(latDegrees + latDelta, 90)),
    lonMin: lonToUnits(Math.max(lonDegrees - lonDelta, -180)),
    lonMax: lonToUnits(Math.min(lonDegrees + lonDelta, 180)),
  };
  assertGeoBox(box);
  return box;
}

/**
 * A place where custody changes hands. Its geofence is public (a warehouse's address is not a
 * secret); what stays private is where exactly inside it the device was.
 */
export type Venue = {
  venueId: string;
  name: string;
  box: GeoBox;
  /** Address of the venue's BLE anchor key, if the venue has one. */
  anchor?: Hex;
};

const VENUE_MAGIC = utf8('PPV1');

/**
 * Identifies a venue *and* its geofence: SHA-256("PPV1" ‖ venue_id (32) ‖ lat_min ‖ lat_max ‖
 * lon_min ‖ lon_max). A proof made for one box cannot be passed off as being for another venue
 * with the same name.
 */
export function venueHash(venueId: string, box: GeoBox): Uint8Array {
  assertGeoBox(box);
  return sha256(
    concat(
      VENUE_MAGIC,
      asciiFixed(venueId, 32),
      u32be(box.latMin),
      u32be(box.latMax),
      u32be(box.lonMin),
      u32be(box.lonMax),
    ),
  );
}

export function venueHashHex(venue: Pick<Venue, 'venueId' | 'box'>): Hex {
  return toHex(venueHash(venue.venueId, venue.box));
}
