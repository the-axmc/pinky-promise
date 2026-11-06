/**
 * The board bridge protocol: how the host talks to an ESP32-S3 running the `pinky-bridge`
 * firmware (firmware/pinky-bridge), over USB serial at 115200 baud.
 *
 * JSON Lines, strictly request/response, host initiates:
 *
 *   → {"id":7,"cmd":"climate.read"}
 *   ← {"id":7,"ok":true,"temp_centi":425,"rh_centi":4550}
 *   ← {"id":8,"ok":false,"error":"sht31 not found"}
 *
 * A line that does not start with "{" is a log line from the board and is ignored. Binary values
 * are lowercase hex without a 0x prefix. A command for a part the board does not have answers
 * {"ok":false,"error":"unsupported"}, and `info` says up front which parts are present.
 *
 * This is deliberately the lowest common denominator: each command maps to one hardware seam,
 * so parts can be brought up one at a time while the rest stays simulated. The board never
 * hashes with keccak and never formats an address: it returns public keys and raw r ‖ s
 * signatures, and the host does the rest.
 */

export type BoardRole = 'device' | 'anchor';

/** The parts a board can report. Each one is a line of the shopping list. */
export type BoardParts = {
  /** SHT31 temperature / humidity sensor answered on I2C. */
  sht31: boolean;
  /** ATECC608B answered on I2C. `se.info` says whether it is provisioned. */
  atecc608b: boolean;
  /** A GPS module is configured (it may still have no fix). */
  gps: boolean;
  /** The camera initialised. */
  camera: boolean;
  /** PN532 NFC reader answered. */
  pn532: boolean;
  /** An enclosure tamper switch is configured. */
  enclosure: boolean;
  /** The secp256k1 wallet key exists in flash. */
  wallet: boolean;
  /** The board can answer `anchor.attest`: it is an anchor, or a device that reaches one over BLE. */
  anchor: boolean;
};

/** `info` — what the board is and which parts answered at boot. */
export type BoardInfo = { fw: string; role: BoardRole; board: string; has: BoardParts };

export type BoardCommands = {
  info: { request: {}; response: BoardInfo };

  /** SHT31: hundredths of °C and of %RH. */
  'climate.read': { request: {}; response: { temp_centi: number; rh_centi: number } };

  /** GPS module (NMEA over UART): position in 1e-7 degrees, and how old the fix is. */
  'gps.read': { request: {}; response: { fix: boolean; lat_e7?: number; lon_e7?: number; sats?: number; age_ms?: number } };

  /** ATECC608B: serial number (9 bytes), the P-256 public key of slot 0 (64 bytes), lock state. */
  'se.info': { request: {}; response: { serial: string; pubkey: string; locked: boolean } };
  /** ATECC608B: ECDSA signature r ‖ s (64 bytes) over a 32-byte digest, by the slot 0 key. */
  'se.sign': { request: { digest: string }; response: { sig: string } };
  /**
   * ATECC608B, once per chip and IRREVERSIBLE: write the configuration, lock it, generate the
   * key in slot 0 and lock the data zone. `confirm` must be the literal "LOCK-FOREVER".
   */
  'se.provision': { request: { confirm: string }; response: { serial: string; pubkey: string; locked: boolean } };

  /** The secp256k1 device wallet kept in the ESP32's NVS flash: public key x ‖ y (64 bytes). */
  'wallet.info': { request: {}; response: { pubkey: string } };
  /** secp256k1 signature r ‖ s (64 bytes) over a 32-byte digest. The host derives v. */
  'wallet.sign': { request: { digest: string }; response: { sig: string } };

  /** Camera: one JPEG frame, base64. */
  'camera.capture': { request: {}; response: { mime: string; data: string } };

  /** PN532: the NFC tag in the field, if any, with its tamper-loop state when it has one. */
  'nfc.read': {
    request: { timeout_ms?: number };
    response: { present: boolean; uid?: string; type?: string; tamper?: 'closed' | 'open' | 'unknown'; ndef?: string };
  };

  /** Enclosure tamper switch: current state and how often it has opened since provisioning. */
  'enclosure.read': { request: {}; response: { closed: boolean; open_count: number } };

  /** Status LED / display. */
  'display.show': { request: { state: string; detail?: string }; response: {} };

  /** Which venue the anchor stands for, and its secp256k1 public key (64 bytes). */
  'anchor.info': { request: {}; response: { venue_id: string; pubkey: string } };
  /** Anchor role, once: set the venue this anchor is bolted to. */
  'anchor.configure': { request: { venue_id: string }; response: { venue_id: string } };
  /**
   * Co-sign a device's nonce. Returns the PPA1 payload (96 bytes) and r ‖ s over its SHA-256.
   * An anchor board answers it itself; a device board relays it to an anchor over BLE, which
   * is what makes the answer evidence of proximity.
   */
  'anchor.attest': {
    request: { device: string; blockhash: string };
    response: { payload: string; sig: string; pubkey: string; rssi?: number };
  };
};

export type BoardCommand = keyof BoardCommands;

export class BoardError extends Error {
  readonly command: string;
  /** The board's own words, e.g. "unsupported" or "sht31 crc". */
  readonly reason: string;

  constructor(command: string, reason: string) {
    super(`board: ${command}: ${reason}`);
    this.name = 'BoardError';
    this.command = command;
    this.reason = reason;
  }
}
