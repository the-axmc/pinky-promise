/**
 * Simulated implementations of every hardware seam. Together they are the "mock device"; each
 * one can be swapped for its real counterpart in src/bridge without touching the others.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Hex,
  type SealEvidence,
  type SignedAnchorAttestation,
  type TamperState,
  fromHex,
  p256GenerateSecret,
  p256PublicKey,
  p256Sign,
  randomBytes,
  secpAddress,
  secpGenerateSecret,
  secpSign,
  sha256,
  signAnchorAttestation,
  toHex,
} from '@pinky/protocol';
import type {
  AnchorSource,
  ClimateSensor,
  Clock,
  DeviceHardware,
  DeviceStatus,
  PositionSource,
  SealCapture,
  SealSource,
  SecureElement,
  StatusDisplay,
  WalletSigner,
} from '../seams';

const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets');

/** The secrets a simulated device keeps in a file. On hardware they never leave the board. */
export type SimulatedIdentity = { hwSecret: Hex; hwSerial: Hex; walletSecret: Hex };

export function generateIdentity(): SimulatedIdentity {
  return {
    hwSecret: toHex(p256GenerateSecret()),
    // ATECC608B serials start 0x01 0x23 and end 0xEE; the middle is unique per chip.
    hwSerial: toHex(Uint8Array.of(0x01, 0x23, ...randomBytes(6), 0xee)),
    walletSecret: toHex(secpGenerateSecret()),
  };
}

/** A software ATECC608B: same interface, but the key sits in memory. */
export class SimulatedSecureElement implements SecureElement {
  readonly #secret: Uint8Array;
  readonly #serial: Hex;

  constructor(secret: Hex, serial: Hex) {
    this.#secret = fromHex(secret, 32);
    this.#serial = toHex(fromHex(serial, 9));
  }

  async serial(): Promise<Hex> {
    return this.#serial;
  }

  async publicKey(): Promise<Uint8Array> {
    return p256PublicKey(this.#secret);
  }

  async sign(digest: Uint8Array): Promise<Uint8Array> {
    return p256Sign(digest, this.#secret);
  }
}

/** The device wallet with its key in software. */
export class SoftwareWallet implements WalletSigner {
  readonly #secret: Uint8Array;

  constructor(secret: Hex) {
    this.#secret = fromHex(secret, 32);
  }

  async address(): Promise<Address> {
    return secpAddress(this.#secret);
  }

  async signDigest(digest: Uint8Array): Promise<Uint8Array> {
    return secpSign(digest, this.#secret);
  }
}

/** An SHT31 that reports whatever the scenario last set. */
export class ScriptedClimate implements ClimateSensor {
  tempCenti = 500;
  rhCenti = 4500;

  set(tempCenti: number, rhCenti: number): void {
    this.tempCenti = Math.round(tempCenti);
    this.rhCenti = Math.round(rhCenti);
  }

  async read() {
    return { tempCenti: this.tempCenti, rhCenti: this.rhCenti };
  }
}

/** A GPS that reports whatever the scenario last set; `null` means no fix. */
export class ScriptedPosition implements PositionSource {
  #fix: { latDeg: number; lonDeg: number } | null = null;

  set(fix: { latDeg: number; lonDeg: number } | null): void {
    this.#fix = fix;
  }

  async read() {
    return this.#fix;
  }
}

export type SealCondition = 'intact' | 'broken';

/**
 * A camera pointed at one of two bundled pictures, optionally with an NFC seal tag whose tamper
 * loop follows the same condition.
 */
export class SimulatedSeal implements SealSource {
  condition: SealCondition = 'intact';
  readonly #nfcUid: Hex | undefined;

  constructor(options: { nfcUid?: Hex } = {}) {
    this.#nfcUid = options.nfcUid;
  }

  async capture(): Promise<SealCapture> {
    const bytes = new Uint8Array(readFileSync(resolve(ASSETS, `seal-${this.condition}.png`)));
    const tamper: TamperState = this.condition === 'intact' ? 'closed' : 'open';
    const evidence: SealEvidence = {
      v: 1,
      photo: { sha256: toHex(sha256(bytes)), mime: 'image/png', source: 'simulated' },
      ...(this.#nfcUid ? { nfc: { uid: this.#nfcUid, tagType: 'simulated', tamper } } : {}),
    };
    return { evidence, photo: { bytes, mime: 'image/png' } };
  }
}

/** A venue anchor in software. It answers only while the device is "at" its venue. */
export class SimulatedAnchor implements AnchorSource {
  readonly #secret: Uint8Array;
  #venueId: string | null = null;
  #counter = 0;

  constructor(secret: Hex) {
    this.#secret = fromHex(secret, 32);
  }

  get address(): Address {
    return secpAddress(this.#secret);
  }

  /** Puts the device in range of the anchor of `venueId`, or out of range with null. */
  setVenue(venueId: string | null): void {
    this.#venueId = venueId;
  }

  async attest(request: { device: Address; blockhash: Hex }): Promise<SignedAnchorAttestation | null> {
    if (!this.#venueId) return null;
    this.#counter += 1;
    return signAnchorAttestation(
      { venueId: this.#venueId, device: request.device, blockhash: request.blockhash, counter: this.#counter },
      this.#secret,
    );
  }
}

/** No venue anchor in range, ever — for boards deployed without one. */
export const noAnchor: AnchorSource = { attest: async () => null };

export const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

/** Remembers the last status, and optionally prints each change. */
export class RecordingDisplay implements StatusDisplay {
  last: DeviceStatus = { state: 'IDLE' };
  readonly history: DeviceStatus[] = [];
  readonly #log: ((status: DeviceStatus) => void) | undefined;

  constructor(log?: (status: DeviceStatus) => void) {
    this.#log = log;
  }

  show(status: DeviceStatus): void {
    this.last = status;
    this.history.push(status);
    this.#log?.(status);
  }
}

/** The handles a scenario uses to steer a fully simulated device. */
export type SimulatedHardware = DeviceHardware & {
  climate: ScriptedClimate;
  position: ScriptedPosition;
  seal: SimulatedSeal;
  display: RecordingDisplay;
};

export function createSimulatedHardware(
  identity: SimulatedIdentity,
  options: { anchor?: AnchorSource; clock?: Clock; nfcUid?: Hex; log?: (status: DeviceStatus) => void } = {},
): SimulatedHardware {
  return {
    secureElement: new SimulatedSecureElement(identity.hwSecret, identity.hwSerial),
    wallet: new SoftwareWallet(identity.walletSecret),
    climate: new ScriptedClimate(),
    position: new ScriptedPosition(),
    seal: new SimulatedSeal({ nfcUid: options.nfcUid }),
    anchor: options.anchor ?? noAnchor,
    clock: options.clock ?? systemClock,
    display: new RecordingDisplay(options.log),
  };
}
