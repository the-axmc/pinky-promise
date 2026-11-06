/**
 * A board that exists only in memory. It speaks the bridge protocol exactly as the firmware
 * does — JSON lines, bare hex, r ‖ s signatures, "unsupported" for missing parts — so the whole
 * host side of the bridge can be exercised with no hardware attached, and a test can unplug it,
 * break a part or pull the seal tag away.
 *
 * It is the reference for firmware authors too: whatever this answers, the firmware must.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Hex,
  encodeAnchorAttestation,
  fromHex,
  p256GenerateSecret,
  p256PublicKey,
  p256Sign,
  randomBytes,
  secpGenerateSecret,
  secpPublicKey,
  secpSign,
  sha256,
  toHex,
} from '@pinky/protocol';
import type { LineTransport } from './client';
import type { BoardInfo, BoardParts, BoardRole } from './protocol';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const bare = (bytes: Uint8Array): string => toHex(bytes).slice(2);
const unhex = (value: unknown, length: number): Uint8Array => {
  if (typeof value !== 'string' || !/^[0-9a-f]*$/.test(value)) throw new Error('bad hex');
  return fromHex(`0x${value}`, length);
};

const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets');
/** The same two pictures the simulator's camera is pointed at. */
const sealPicture = (condition: 'intact' | 'broken') => ({
  bytes: new Uint8Array(readFileSync(resolve(ASSETS, `seal-${condition}.png`))),
  mime: 'image/png',
});

export type MockBoardOptions = {
  role?: BoardRole;
  /** Which parts are wired. Default: every part the role can have. */
  parts?: Partial<BoardParts>;
  seSecret?: Hex;
  seSerial?: Hex;
  /** The device wallet key (device role) or the anchor's signing key (anchor role). */
  walletSecret?: Hex;
  /** Anchor role: the venue it stands for. */
  venueId?: string;
  /** A device board that reaches this anchor "over BLE" when asked to attest. */
  bleAnchor?: MockBoard;
  /** Return secp256k1 signatures with s in the high half, as micro-ecc is free to do. */
  highS?: boolean;
};

export class MockBoard {
  readonly role: BoardRole;
  readonly parts: BoardParts;
  readonly transport: LineTransport;

  /** What the SHT31 reads. */
  climate = { tempCenti: 480, rhCenti: 4500 };
  /** The GPS fix, or null for none. `ageMs` is how long ago the module last had it. */
  gps: { latDeg: number; lonDeg: number; sats?: number; ageMs?: number } | null = null;
  /** The frame the camera returns. Starts as the picture of an intact seal. */
  photo: { bytes: Uint8Array; mime: string } = sealPicture('intact');
  /** The NFC tag in the reader's field, or null for none. */
  nfc: { uid: Hex; type?: string; tamper?: 'closed' | 'open' | 'unknown'; ndef?: string } | null = {
    uid: '0x04a1b2c3d4e5f6',
    type: 'ntag21x',
    tamper: 'unknown',
  };
  enclosure = { closed: true, openCount: 0 };
  /** The ATECC608B is blank until `se.provision`, like a chip fresh from the bag. */
  seProvisioned = true;
  /** Everything `display.show` was asked to show. */
  readonly shown: Array<{ state: string; detail?: string }> = [];
  /** Every command received, in order. */
  readonly received: string[] = [];
  /** True once the host closed the port. */
  closed = false;

  readonly #seSecret: Uint8Array;
  readonly #seSerial: Uint8Array;
  readonly #walletSecret: Uint8Array;
  readonly #highS: boolean;
  readonly #bleAnchor: MockBoard | undefined;
  readonly #listeners: Array<(line: string) => void> = [];
  readonly #broken = new Map<string, string>();
  #venueId: string;
  #counter = 0;
  #unplugged = false;

  constructor(options: MockBoardOptions = {}) {
    this.role = options.role ?? 'device';
    const device = this.role === 'device';
    this.parts = {
      sht31: device,
      atecc608b: device,
      gps: device,
      camera: device,
      pn532: device,
      enclosure: device,
      wallet: true,
      anchor: !device || options.bleAnchor !== undefined,
      ...options.parts,
    };
    this.#seSecret = options.seSecret ? fromHex(options.seSecret, 32) : p256GenerateSecret();
    this.#seSerial = options.seSerial
      ? fromHex(options.seSerial, 9)
      : Uint8Array.of(0x01, 0x23, ...randomBytes(6), 0xee);
    this.#walletSecret = options.walletSecret ? fromHex(options.walletSecret, 32) : secpGenerateSecret();
    this.#venueId = options.venueId ?? '';
    this.#highS = options.highS ?? false;
    this.#bleAnchor = options.bleAnchor;

    this.transport = {
      send: (line) => {
        // A real port delivers asynchronously; so does this one.
        setTimeout(() => this.#receive(line), 0);
      },
      onLine: (listener) => {
        this.#listeners.push(listener);
        setTimeout(() => listener(`pinky-bridge mock ${this.role} ready`), 0);
      },
      close: async () => {
        this.closed = true;
      },
    };
  }

  /** The public key of the wallet (device role) or of the anchor (anchor role), x ‖ y. */
  get publicKey(): Uint8Array {
    return secpPublicKey(this.#walletSecret);
  }

  /** Points the camera at the intact or the broken seal. */
  showSeal(condition: 'intact' | 'broken'): void {
    this.photo = sealPicture(condition);
  }

  /** Pulls the cable: every later request goes unanswered. `replug()` undoes it. */
  unplug(): void {
    this.#unplugged = true;
  }

  replug(): void {
    this.#unplugged = false;
  }

  /** Makes a command fail the way a loose wire would, until `repair`. */
  breakPart(command: string, error: string): void {
    this.#broken.set(command, error);
  }

  repair(command: string): void {
    this.#broken.delete(command);
  }

  #emit(line: string): void {
    for (const listener of this.#listeners) listener(line);
  }

  #receive(line: string): void {
    if (this.#unplugged || this.closed) return;
    let message: { id?: unknown; cmd?: unknown } & Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      this.#emit('E (bridge) line is not JSON');
      return;
    }
    const { id, cmd, ...params } = message;
    this.received.push(String(cmd));
    try {
      this.#emit(JSON.stringify({ id, ok: true, ...this.#run(String(cmd), params) }));
    } catch (error) {
      this.#emit(JSON.stringify({ id, ok: false, error: (error as Error).message }));
    }
  }

  #need(part: keyof BoardParts): void {
    if (!this.parts[part]) throw new Error('unsupported');
  }

  /** secp256k1 r ‖ s, with no recovery byte — all a microcontroller library returns. */
  #secpSign(digest: Uint8Array): Uint8Array {
    const signature = secpSign(digest, this.#walletSecret).slice(0, 64);
    if (this.#highS) {
      const s = SECP256K1_N - BigInt(toHex(signature.subarray(32)));
      signature.set(fromHex(`0x${s.toString(16).padStart(64, '0')}`, 32), 32);
    }
    return signature;
  }

  #run(command: string, params: Record<string, unknown>): Record<string, unknown> {
    const broken = this.#broken.get(command);
    if (broken) throw new Error(broken);

    switch (command) {
      case 'info': {
        const info: BoardInfo = { fw: 'mock-0.1.0', role: this.role, board: 'mock', has: { ...this.parts } };
        return info;
      }
      case 'climate.read':
        this.#need('sht31');
        return { temp_centi: this.climate.tempCenti, rh_centi: this.climate.rhCenti };
      case 'gps.read':
        this.#need('gps');
        if (!this.gps) return { fix: false, sats: 0 };
        return {
          fix: true,
          lat_e7: Math.round(this.gps.latDeg * 1e7),
          lon_e7: Math.round(this.gps.lonDeg * 1e7),
          sats: this.gps.sats ?? 9,
          age_ms: this.gps.ageMs ?? 400,
        };
      case 'se.info':
        this.#need('atecc608b');
        if (!this.seProvisioned) throw new Error('atecc608b not provisioned');
        return { serial: bare(this.#seSerial), pubkey: bare(p256PublicKey(this.#seSecret)), locked: true };
      case 'se.sign':
        this.#need('atecc608b');
        if (!this.seProvisioned) throw new Error('atecc608b not provisioned');
        return { sig: bare(p256Sign(unhex(params.digest, 32), this.#seSecret)) };
      case 'se.provision':
        this.#need('atecc608b');
        if (params.confirm !== 'LOCK-FOREVER') throw new Error('confirm must be LOCK-FOREVER');
        if (this.seProvisioned) throw new Error('atecc608b already locked');
        this.seProvisioned = true;
        return { serial: bare(this.#seSerial), pubkey: bare(p256PublicKey(this.#seSecret)), locked: true };
      case 'wallet.info':
        if (this.role !== 'device') throw new Error('unsupported');
        this.#need('wallet');
        return { pubkey: bare(this.publicKey) };
      case 'wallet.sign':
        if (this.role !== 'device') throw new Error('unsupported');
        this.#need('wallet');
        return { sig: bare(this.#secpSign(unhex(params.digest, 32))) };
      case 'camera.capture':
        this.#need('camera');
        return { mime: this.photo.mime, data: Buffer.from(this.photo.bytes).toString('base64') };
      case 'nfc.read':
        this.#need('pn532');
        if (!this.nfc) return { present: false };
        return {
          present: true,
          uid: this.nfc.uid.slice(2),
          ...(this.nfc.type ? { type: this.nfc.type } : {}),
          tamper: this.nfc.tamper ?? 'unknown',
          ...(this.nfc.ndef ? { ndef: this.nfc.ndef } : {}),
        };
      case 'enclosure.read':
        this.#need('enclosure');
        return { closed: this.enclosure.closed, open_count: this.enclosure.openCount };
      case 'display.show':
        this.shown.push({
          state: String(params.state),
          ...(typeof params.detail === 'string' ? { detail: params.detail } : {}),
        });
        return {};
      case 'anchor.info':
        if (this.role !== 'anchor') throw new Error('unsupported');
        if (!this.#venueId) throw new Error('anchor has no venue configured');
        return { venue_id: this.#venueId, pubkey: bare(this.publicKey) };
      case 'anchor.configure':
        if (this.role !== 'anchor') throw new Error('unsupported');
        if (typeof params.venue_id !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(params.venue_id)) {
          throw new Error('bad venue_id');
        }
        this.#venueId = params.venue_id;
        return { venue_id: this.#venueId };
      case 'anchor.attest': {
        this.#need('anchor');
        if (this.role === 'device') {
          // The device relays to the anchor it can hear. None in range: the scan finds nothing.
          if (!this.#bleAnchor || this.#bleAnchor.#unplugged) throw new Error('no anchor in range');
          return { ...this.#bleAnchor.#run('anchor.attest', params), rssi: -52 };
        }
        if (!this.#venueId) throw new Error('anchor has no venue configured');
        this.#counter += 1;
        const payload = encodeAnchorAttestation({
          venueId: this.#venueId,
          device: toHex(unhex(params.device, 20)),
          blockhash: toHex(unhex(params.blockhash, 32)),
          counter: this.#counter,
        });
        return {
          payload: bare(payload),
          sig: bare(this.#secpSign(sha256(payload))),
          pubkey: bare(this.publicKey),
        };
      }
      default:
        throw new Error('unknown command');
    }
  }
}
