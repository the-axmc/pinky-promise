/**
 * The device's logic: everything between its sensors and the gateway.
 *
 * It is written against the seams in seams.ts and knows nothing about what is behind them, so
 * the same code runs fully simulated, with some real parts, or with all of them. Firmware that
 * moves this logic onto the ESP32 has to reproduce four behaviours:
 *
 *   1. never reuse a sequence number (the counter is persisted before anything is signed);
 *   2. sign readings and checkpoints exactly as packages/protocol lays them out;
 *   3. trust limits only from a registry-signed lot profile;
 *   4. sign an Arkiv transaction only after signing-policy.ts has approved its contents.
 */
import {
  type Address,
  type CheckpointKindValue,
  type GpsOpening,
  type Hex,
  type LotProfile,
  ProtocolError,
  type SignedLotProfile,
  ZERO_32,
  checkpointDigest,
  concat,
  encodeCheckpoint,
  encodeDeviceCert,
  encodeReading,
  encodeSealEvidence,
  fromHex,
  gpsCommitment,
  isInRange,
  latToUnits,
  lonToUnits,
  noFixOpening,
  randomBytes,
  readingDigest,
  readingsRoot,
  sameAddress,
  sealHash,
  sha256,
  toHex,
  verifyAnchorAttestation,
  verifyLotProfile,
} from '@pinky/protocol';
import { keccak256, serializeTransaction } from 'viem';
import type { DeviceHardware } from './seams';
import { type PolicyContext, type StoredCheckpoint, type StoredReading, reviewTransaction } from './signing-policy';
import type {
  ChainAnchor,
  CheckpointRequest,
  CheckpointResponse,
  ReadingRequest,
  SignRequest,
  SignatureSubmission,
} from './wire';

export type DeviceConfig = {
  /** Whose lot profiles the device trusts. Fixed at provisioning. */
  registry: Address;
  /** Whose decision attestations may appear in the device's Checkpoint entities. */
  attestor: Address;
  arkivChainId: number;
  /** Upper bound on the gas of a transaction the device will sign. */
  maxGas?: bigint;
  /** Upper bound on gas × gasPrice of a transaction the device will sign, in wei. */
  maxFeeWei?: bigint;
};

/** What survives a power cycle. On an ESP32 this lives in NVS flash. */
export type DeviceState = {
  seq: number;
  /** seq of the last checkpoint taken; the next one bundles readings after it. */
  lastCheckpointSeq: number;
  certBundle?: Hex;
  signedProfile?: SignedLotProfile;
  readings: StoredReading[];
  checkpoints: StoredCheckpoint[];
};

export interface DeviceStorage {
  load(): DeviceState | undefined;
  save(state: DeviceState): void;
}

const MAX_STORED_READINGS = 2000;
const MAX_STORED_CHECKPOINTS = 100;
const DEFAULT_MAX_GAS = 12_000_000n;
const DEFAULT_MAX_FEE_WEI = 10n ** 17n; // 0.1 of the gas token per transaction

export class Device {
  readonly address: Address;
  readonly #hardware: DeviceHardware;
  readonly #storage: DeviceStorage;
  readonly #config: DeviceConfig;
  #state: DeviceState;
  #profile: LotProfile | undefined;

  private constructor(address: Address, hardware: DeviceHardware, storage: DeviceStorage, config: DeviceConfig) {
    this.address = address;
    this.#hardware = hardware;
    this.#storage = storage;
    this.#config = config;
    this.#state = storage.load() ?? { seq: 0, lastCheckpointSeq: 0, readings: [], checkpoints: [] };
    if (this.#state.signedProfile) this.#profile = this.#checkProfile(this.#state.signedProfile);
  }

  static async create(hardware: DeviceHardware, storage: DeviceStorage, config: DeviceConfig): Promise<Device> {
    return new Device(await hardware.wallet.address(), hardware, storage, config);
  }

  get profile(): LotProfile | undefined {
    return this.#profile;
  }

  get seq(): number {
    return this.#state.seq;
  }

  /**
   * The certificate binding this wallet to the hardware key, issued once and then kept.
   * This is the one time the secure element signs.
   */
  async certificate(): Promise<Hex> {
    if (this.#state.certBundle) return this.#state.certBundle;
    const { secureElement, wallet, clock } = this.#hardware;
    const payload = encodeDeviceCert({
      device: this.address,
      hwPubkey: toHex(await secureElement.publicKey()),
      hwSerial: await secureElement.serial(),
      issuedAt: clock.now(),
    });
    const digest = sha256(payload);
    const bundle = toHex(concat(payload, await secureElement.sign(digest), await wallet.signDigest(digest)));
    this.#state.certBundle = bundle;
    this.#save();
    return bundle;
  }

  /** Accepts a lot assignment, but only if the registry signed it and it names this device. */
  setProfile(signed: SignedLotProfile): LotProfile {
    this.#profile = this.#checkProfile(signed);
    this.#state.signedProfile = signed;
    this.#save();
    return this.#profile;
  }

  #checkProfile(signed: SignedLotProfile): LotProfile {
    const { profile, signer } = verifyLotProfile(signed);
    if (!sameAddress(signer, this.#config.registry)) {
      throw new ProtocolError(`lot profile is signed by ${signer}, not by the registry this device trusts`);
    }
    if (!sameAddress(profile.device, this.address)) throw new ProtocolError('lot profile is for another device');
    if (profile.validUntil <= this.#hardware.clock.now()) throw new ProtocolError('lot profile has expired');
    return profile;
  }

  /** Measures, signs and remembers one reading. */
  async takeReading(anchor: ChainAnchor): Promise<ReadingRequest> {
    const profile = this.#requireProfile();
    const { climate, position, wallet, clock, display } = this.#hardware;
    display.show({ state: 'READING' });

    const { tempCenti, rhCenti } = await climate.read();
    const fix = await position.read();
    const salt = randomBytes(32);
    const opening: GpsOpening = fix
      ? { latUnits: latToUnits(fix.latDeg), lonUnits: lonToUnits(fix.lonDeg), salt }
      : noFixOpening(salt);

    const seq = this.#nextSeq();
    const reading = {
      device: this.address,
      assetId: profile.assetId,
      tempCenti,
      rhCenti,
      gpsCommitment: toHex(gpsCommitment(opening)),
      ts: clock.now(),
      seq,
      blockhash: anchor.blockHash,
    };
    const payload = encodeReading(reading);
    const digest = readingDigest(payload);
    const sig = toHex(await wallet.signDigest(digest));

    this.#state.readings.push({
      reading,
      digest: toHex(digest),
      sig,
      inRange: isInRange(profile, tempCenti, rhCenti),
      anchorBlock: anchor.blockNumber,
    });
    this.#save();
    display.show({ state: 'IDLE' });

    return {
      payload: toHex(payload),
      sig,
      // Without a fix there is nothing to prove, so nothing private to share.
      ...(fix ? { opening: { latUnits: opening.latUnits, lonUnits: opening.lonUnits, salt: toHex(salt) } } : {}),
    };
  }

  /** Records the seal, asks the venue anchor to co-sign, and bundles the readings since the last checkpoint. */
  async takeCheckpoint(kind: CheckpointKindValue, anchor: ChainAnchor): Promise<CheckpointRequest> {
    const profile = this.#requireProfile();
    const { seal, anchor: venueAnchor, wallet, clock, display } = this.#hardware;

    const window = this.#state.readings.filter((r) => r.reading.seq > this.#state.lastCheckpointSeq);
    if (window.length === 0) throw new ProtocolError('take at least one reading before a checkpoint');

    const capture = await seal.capture();
    if (capture.photo) {
      const photoHash = toHex(sha256(capture.photo.bytes));
      if (capture.evidence.photo?.sha256 !== photoHash) {
        throw new ProtocolError('seal evidence does not reference the photo that was captured');
      }
    } else if (capture.evidence.photo) {
      throw new ProtocolError('seal evidence references a photo that was not captured');
    }
    const sealRecord = encodeSealEvidence(capture.evidence);

    const attestation = await venueAnchor.attest({ device: this.address, blockhash: anchor.blockHash });
    let anchorDigest: Hex = ZERO_32;
    if (attestation) {
      const verified = verifyAnchorAttestation(attestation);
      if (!sameAddress(verified.attestation.device, this.address) || verified.attestation.blockhash !== anchor.blockHash) {
        throw new ProtocolError('venue anchor signed something other than what was asked');
      }
      anchorDigest = toHex(verified.digest);
    }

    const seq = this.#nextSeq();
    const checkpoint = {
      device: this.address,
      assetId: profile.assetId,
      kind,
      ts: clock.now(),
      seq,
      firstSeq: window[0]!.reading.seq,
      lastSeq: window[window.length - 1]!.reading.seq,
      readingCount: window.length,
      readingsRoot: toHex(readingsRoot(window.map((r) => fromHex(r.digest, 32)))),
      sealHash: sealHash(sealRecord),
      anchorDigest,
      blockhash: anchor.blockHash,
    };
    const payload = encodeCheckpoint(checkpoint);
    const id = toHex(checkpointDigest(payload));
    const sig = toHex(await wallet.signDigest(checkpointDigest(payload)));

    this.#state.checkpoints.push({
      checkpoint,
      id,
      payload: toHex(payload),
      sig,
      ...(attestation ? { anchor: attestation } : {}),
    });
    this.#state.lastCheckpointSeq = seq;
    this.#save();
    // Until a decision comes back the handoff is not accepted, and the device says so.
    display.show({ state: 'PENDING', detail: id });

    return {
      payload: toHex(payload),
      sig,
      seal: Buffer.from(sealRecord).toString('base64'),
      ...(capture.photo
        ? { photo: { mime: capture.photo.mime, data: Buffer.from(capture.photo.bytes).toString('base64') } }
        : {}),
      ...(attestation ? { anchor: attestation } : {}),
    };
  }

  /** Reviews an Arkiv transaction against the signing policy and signs it, or says why not. */
  async sign(request: SignRequest): Promise<SignatureSubmission> {
    const review = reviewTransaction(request, this.#policyContext());
    if (!review.ok) return { id: request.id, refused: review.reason };

    const { transaction } = request;
    // Serialised here, from the reviewed fields: the device signs what it checked.
    const serialized = serializeTransaction({
      type: 'legacy',
      chainId: transaction.chainId,
      nonce: transaction.nonce,
      gas: BigInt(transaction.gas),
      gasPrice: BigInt(transaction.gasPrice),
      to: transaction.to,
      value: BigInt(transaction.value),
      data: transaction.data,
    });
    const signature = await this.#hardware.wallet.signDigest(fromHex(keccak256(serialized), 32));

    for (const decided of review.checkpoints) {
      if (decided.decision === 'PENDING') continue;
      const stored = this.#state.checkpoints.find((c) => c.id === decided.id);
      if (stored) stored.decided = true;
      this.#hardware.display.show({ state: decided.outcome as CheckpointResponse['status'], detail: decided.reason });
    }
    this.#save();

    return {
      id: request.id,
      signature: {
        r: toHex(signature.subarray(0, 32)),
        s: toHex(signature.subarray(32, 64)),
        yParity: (signature[64]! - 27) as 0 | 1,
      },
    };
  }

  /** A reading as it was signed, for resending one the gateway did not receive. */
  storedReading(seq: number): ReadingRequest | undefined {
    const stored = this.#state.readings.find((r) => r.reading.seq === seq);
    return stored ? { payload: toHex(encodeReading(stored.reading)), sig: stored.sig } : undefined;
  }

  /** Shows what the gateway reports for a checkpoint (used while a decision is pending). */
  showStatus(response: CheckpointResponse): void {
    this.#hardware.display.show({ state: response.status, detail: response.reason });
  }

  #requireProfile(): LotProfile {
    if (!this.#profile) throw new ProtocolError('device has no lot assigned');
    return this.#profile;
  }

  /** Advances and persists the counter before anything is signed with it. */
  #nextSeq(): number {
    this.#state.seq += 1;
    this.#save();
    return this.#state.seq;
  }

  #save(): void {
    const { readings, checkpoints } = this.#state;
    if (readings.length > MAX_STORED_READINGS) readings.splice(0, readings.length - MAX_STORED_READINGS);
    if (checkpoints.length > MAX_STORED_CHECKPOINTS) checkpoints.splice(0, checkpoints.length - MAX_STORED_CHECKPOINTS);
    this.#storage.save(this.#state);
  }

  #policyContext(): PolicyContext {
    const state = this.#state;
    return {
      self: this.address,
      arkivChainId: this.#config.arkivChainId,
      attestor: this.#config.attestor,
      maxGas: this.#config.maxGas ?? DEFAULT_MAX_GAS,
      maxFeeWei: this.#config.maxFeeWei ?? DEFAULT_MAX_FEE_WEI,
      reading: (digest) => state.readings.find((r) => r.digest === digest.toLowerCase()),
      checkpoint: (id) => state.checkpoints.find((c) => c.id === id.toLowerCase()),
      readingsInWindow: (first, last) => state.readings.filter((r) => r.reading.seq >= first && r.reading.seq <= last),
    };
  }
}
