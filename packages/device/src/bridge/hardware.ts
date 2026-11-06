/**
 * The hardware seams, implemented by a real board over the bridge. One class per part, each a
 * thin translation of a seam call into a bridge command — so swapping a simulated part for a
 * real one is a one-line change in how the device is assembled (see assemble.ts).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  type Address,
  type Hex,
  ProtocolError,
  type SealEvidence,
  type SealPhotoSource,
  type SignedAnchorAttestation,
  addressFromPublicKey,
  concat,
  fromHex,
  sameAddress,
  secpRecover,
  sha256,
  toHex,
} from '@pinky/protocol';
import type {
  AnchorSource,
  ClimateSensor,
  DeviceStatus,
  PositionSource,
  SealCapture,
  SealSource,
  SecureElement,
  StatusDisplay,
  WalletSigner,
} from '../seams';
import type { BoardClient } from './client';

/** The bridge carries hex without a prefix; the protocol package wants 0x and lowercase. */
const hex = (bare: string): Hex => `0x${String(bare).toLowerCase()}`;
const bare = (value: string): string => value.replace(/^0x/, '').toLowerCase();

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Turns the r ‖ s a microcontroller library returns into the protocol's r ‖ s ‖ v: normalises
 * s to the low half (micro-ecc does not) and finds the recovery value by trying both and
 * keeping the one that recovers to the expected signer.
 */
export function toRecoverable(digest: Uint8Array, rs: Uint8Array, signer: Address): Uint8Array {
  if (rs.length !== 64) throw new ProtocolError('board returned a signature that is not 64 bytes');
  const r = rs.subarray(0, 32);
  let s = BigInt(toHex(rs.subarray(32)));
  if (s > SECP256K1_N / 2n) s = SECP256K1_N - s;
  const low = fromHex(`0x${s.toString(16).padStart(64, '0')}`, 32);
  for (const v of [27, 28]) {
    const candidate = concat(r, low, Uint8Array.of(v));
    try {
      if (sameAddress(secpRecover(digest, candidate).address, signer)) return candidate;
    } catch {
      // not this recovery value
    }
  }
  throw new ProtocolError('board signature does not belong to the expected key');
}

/** ATECC608B on the board's I2C bus. */
export class BoardSecureElement implements SecureElement {
  readonly #board: BoardClient;

  constructor(board: BoardClient) {
    this.#board = board;
  }

  async serial(): Promise<Hex> {
    return toHex(fromHex(hex((await this.#board.request('se.info')).serial), 9));
  }

  async publicKey(): Promise<Uint8Array> {
    return fromHex(hex((await this.#board.request('se.info')).pubkey), 64);
  }

  async sign(digest: Uint8Array): Promise<Uint8Array> {
    return fromHex(hex((await this.#board.request('se.sign', { digest: bare(toHex(digest)) })).sig), 64);
  }
}

/** The secp256k1 wallet whose key lives in the ESP32's flash. */
export class BoardWallet implements WalletSigner {
  readonly #board: BoardClient;
  #address: Address | undefined;

  constructor(board: BoardClient) {
    this.#board = board;
  }

  async address(): Promise<Address> {
    this.#address ??= addressFromPublicKey(fromHex(hex((await this.#board.request('wallet.info')).pubkey), 64));
    return this.#address;
  }

  async signDigest(digest: Uint8Array): Promise<Uint8Array> {
    const signer = await this.address();
    const { sig } = await this.#board.request('wallet.sign', { digest: bare(toHex(digest)) });
    return toRecoverable(digest, fromHex(hex(sig), 64), signer);
  }
}

/** SHT31. */
export class BoardClimate implements ClimateSensor {
  readonly #board: BoardClient;

  constructor(board: BoardClient) {
    this.#board = board;
  }

  async read() {
    const { temp_centi, rh_centi } = await this.#board.request('climate.read');
    if (!Number.isInteger(temp_centi) || !Number.isInteger(rh_centi)) {
      throw new ProtocolError('board returned a climate reading that is not in whole hundredths');
    }
    return { tempCenti: temp_centi, rhCenti: rh_centi };
  }
}

/**
 * GPS module. No fix (indoors, cold start) is a normal answer, not an error — and so is a fix
 * that has gone stale: the last known position is not where the device is now.
 */
export class BoardPosition implements PositionSource {
  readonly #board: BoardClient;
  readonly #maxAgeMs: number;

  constructor(board: BoardClient, options: { maxAgeMs?: number } = {}) {
    this.#board = board;
    this.#maxAgeMs = options.maxAgeMs ?? 15_000;
  }

  async read() {
    const answer = await this.#board.request('gps.read');
    if (!answer.fix || answer.lat_e7 === undefined || answer.lon_e7 === undefined) return null;
    if (answer.age_ms !== undefined && answer.age_ms > this.#maxAgeMs) return null;
    return { latDeg: answer.lat_e7 / 1e7, lonDeg: answer.lon_e7 / 1e7 };
  }
}

/** Where a seal photo comes from. */
export type PhotoSource = () => Promise<{ bytes: Uint8Array; mime: string; source: SealPhotoSource }>;

/** The board's own camera. */
export function boardCamera(board: BoardClient): PhotoSource {
  return async () => {
    const { mime, data } = await board.request('camera.capture', {}, 20_000);
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    if (bytes.length === 0) throw new ProtocolError('board returned an empty camera frame');
    return { bytes, mime, source: 'device-camera' };
  };
}

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * A photo taken with something else — a phone, the laptop's camera — and dropped into a file or
 * folder. For a folder the newest image is used. Stands in for a camera the board does not have.
 */
export function filePhoto(path: string): PhotoSource {
  return async () => {
    if (!existsSync(path)) throw new ProtocolError(`no seal photo at ${path}`);
    let file = path;
    if (statSync(path).isDirectory()) {
      const newest = readdirSync(path)
        .filter((name) => extname(name).toLowerCase() in IMAGE_TYPES)
        .map((name) => ({ name, mtime: statSync(join(path, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (!newest) throw new ProtocolError(`no image found in ${path}`);
      file = join(path, newest.name);
    }
    const mime = IMAGE_TYPES[extname(file).toLowerCase()];
    if (!mime) throw new ProtocolError(`${file} is not a supported image type`);
    return { bytes: new Uint8Array(readFileSync(file)), mime, source: 'file' };
  };
}

/** The photo half of a simulated seal, so a real NFC reader can be combined with a fake camera. */
export function simulatedPhoto(seal: SealSource): PhotoSource {
  return async () => {
    const { photo } = await seal.capture();
    if (!photo) throw new ProtocolError('the simulated seal produced no photo');
    return { ...photo, source: 'simulated' };
  };
}

export type SealParts = {
  photo?: PhotoSource;
  /** Board with a PN532: read the NFC seal tag. */
  nfc?: BoardClient;
  /** Board with a tamper switch on its case. */
  enclosure?: BoardClient;
};

/**
 * Seal evidence from whatever the board has: a photo, the NFC seal tag under the PN532, the
 * enclosure switch. At least one must be configured.
 */
export class CompositeSeal implements SealSource {
  readonly #parts: SealParts;

  constructor(parts: SealParts) {
    if (!parts.photo && !parts.nfc && !parts.enclosure) throw new ProtocolError('no source of seal evidence configured');
    this.#parts = parts;
  }

  async capture(): Promise<SealCapture> {
    const evidence: SealEvidence = { v: 1 };
    let photo: SealCapture['photo'];
    if (this.#parts.photo) {
      const shot = await this.#parts.photo();
      photo = { bytes: shot.bytes, mime: shot.mime };
      evidence.photo = { sha256: toHex(sha256(shot.bytes)), mime: shot.mime, source: shot.source };
    }
    if (this.#parts.nfc) {
      const tag = await this.#parts.nfc.request('nfc.read', { timeout_ms: 1500 }, 6_000);
      // A reader that finds no tag is itself an observation: the seal tag is not where it was.
      evidence.nfc =
        tag.present && tag.uid
          ? {
              uid: hex(tag.uid),
              ...(tag.type ? { tagType: tag.type } : {}),
              tamper: tag.tamper ?? 'unknown',
              ...(tag.ndef ? { ndef: tag.ndef.slice(0, 512) } : {}),
            }
          : { uid: '0x00', tagType: 'absent', tamper: 'open' };
    }
    if (this.#parts.enclosure) {
      const state = await this.#parts.enclosure.request('enclosure.read');
      evidence.enclosure = { closed: state.closed, openCount: state.open_count };
    }
    return { evidence, ...(photo ? { photo } : {}) };
  }
}

/**
 * A venue anchor reached through a board: either the anchor board itself on a second USB port,
 * or the device board relaying to an anchor over BLE. Out of range or unplugged resolves to
 * null; `onProblem` hears why, so a wiring fault is not mistaken for "no anchor here".
 */
export class BoardAnchor implements AnchorSource {
  readonly #board: BoardClient;
  readonly #onProblem: ((reason: string) => void) | undefined;
  readonly #minRssi: number | undefined;

  /**
   * `minRssi` (dBm, e.g. -70) tightens "in radio range" for an anchor reached over BLE: a
   * weaker signal counts as no anchor. It has no effect on an anchor plugged in over USB.
   */
  constructor(board: BoardClient, options: { onProblem?: (reason: string) => void; minRssi?: number } = {}) {
    this.#board = board;
    this.#onProblem = options.onProblem;
    this.#minRssi = options.minRssi;
  }

  async attest(request: { device: Address; blockhash: Hex }): Promise<SignedAnchorAttestation | null> {
    try {
      const answer = await this.#board.request(
        'anchor.attest',
        { device: bare(request.device), blockhash: bare(request.blockhash) },
        15_000,
      );
      if (this.#minRssi !== undefined && answer.rssi !== undefined && answer.rssi < this.#minRssi) {
        throw new ProtocolError(`anchor heard at ${answer.rssi} dBm, weaker than the ${this.#minRssi} dBm required`);
      }
      const payload = fromHex(hex(answer.payload));
      const signer = addressFromPublicKey(fromHex(hex(answer.pubkey), 64));
      const sig = toRecoverable(sha256(payload), fromHex(hex(answer.sig), 64), signer);
      return { payload: toHex(payload), sig: toHex(sig) };
    } catch (error) {
      this.#onProblem?.((error as Error).message);
      return null;
    }
  }
}

/** The board's status LED, optionally mirrored to another display. Never stops the device. */
export class BoardDisplay implements StatusDisplay {
  readonly #board: BoardClient;
  readonly #also: StatusDisplay | undefined;
  last: DeviceStatus = { state: 'IDLE' };

  constructor(board: BoardClient, also?: StatusDisplay) {
    this.#board = board;
    this.#also = also;
  }

  show(status: DeviceStatus): void {
    this.last = status;
    this.#also?.show(status);
    this.#board
      .request('display.show', { state: status.state, ...(status.detail ? { detail: status.detail.slice(0, 80) } : {}) })
      .catch(() => {});
  }
}
