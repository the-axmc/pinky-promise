/**
 * The seams where real hardware plugs in — one small interface per part on the board.
 *
 * Everything else in this package is logic over these interfaces. Each has a simulated
 * implementation (src/sim) and a real one that talks to an ESP32 over USB serial (src/bridge),
 * and they are chosen independently, so the SHT31 can be real while the secure element is still
 * simulated. docs/hardware.md maps each part of the shopping list to its seam.
 *
 *   part                 seam            simulated            real (bridge)
 *   -------------------  --------------  -------------------  -----------------------------
 *   ATECC608B            SecureElement   key in a file        chip signs over I2C
 *   ESP32-S3 (wallet)    WalletSigner    key in a file        key in the ESP32's flash
 *   SHT31                ClimateSensor   scripted values      sensor over I2C
 *   GPS (optional)       PositionSource  scripted route       module over UART, or "no fix"
 *   camera / PN532 /     SealSource      bundled images       camera frame, NFC tag read,
 *     enclosure switch                                        switch GPIO
 *   second ESP32-S3      AnchorSource    key in a file        anchor board co-signs
 */
import type { Address, Hex, SealEvidence, SignedAnchorAttestation } from '@pinky/protocol';
import type { CheckpointStatus } from './wire';

/** The hardware root of trust: an ATECC608B holding a P-256 key that never leaves the chip. */
export interface SecureElement {
  /** The chip's 9-byte serial number. */
  serial(): Promise<Hex>;
  /** The public key, x ‖ y (64 bytes) — what the chip returns from GenKey. */
  publicKey(): Promise<Uint8Array>;
  /** Signs a 32-byte digest, returning r ‖ s (64 bytes) — the chip's Sign command. */
  sign(digest: Uint8Array): Promise<Uint8Array>;
}

/** The secp256k1 device wallet: signs every reading and owns the device's Arkiv entities. */
export interface WalletSigner {
  address(): Promise<Address>;
  /** Signs a 32-byte digest: 65 bytes r ‖ s ‖ v, low s, v = 27 | 28. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/** SHT31: temperature in hundredths of °C, relative humidity in hundredths of %. */
export interface ClimateSensor {
  read(): Promise<{ tempCenti: number; rhCenti: number }>;
}

/** GPS. Resolves to null when there is no module or no fix; the reading then says so. */
export interface PositionSource {
  read(): Promise<{ latDeg: number; lonDeg: number } | null>;
}

/** What was observed about the seal, plus the photo itself when there is one. */
export type SealCapture = { evidence: SealEvidence; photo?: { bytes: Uint8Array; mime: string } };

/** Camera, NFC seal tag and/or enclosure switch — whatever this board has. */
export interface SealSource {
  capture(): Promise<SealCapture>;
}

/** The venue anchor in radio range. Resolves to null when none answers. */
export interface AnchorSource {
  attest(request: { device: Address; blockhash: Hex }): Promise<SignedAnchorAttestation | null>;
}

/** GPS time or an RTC, unix seconds. */
export interface Clock {
  now(): number;
}

export type DeviceStatus = { state: 'IDLE' | 'READING' | CheckpointStatus; detail?: string };

/** A status LED or small display. PENDING must be visibly "not accepted". */
export interface StatusDisplay {
  show(status: DeviceStatus): void;
}

export type DeviceHardware = {
  secureElement: SecureElement;
  wallet: WalletSigner;
  climate: ClimateSensor;
  position: PositionSource;
  seal: SealSource;
  anchor: AnchorSource;
  clock: Clock;
  display: StatusDisplay;
};
