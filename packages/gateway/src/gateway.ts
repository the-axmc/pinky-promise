/**
 * The gateway: receives what the device signed and relays it to the three layers.
 *
 *   reading     verify → remember → publish on Arkiv (device-signed) → prove the geofence
 *   checkpoint  verify → ask 0G to decide → store the episode on 0G Storage → attest →
 *               publish on Arkiv (device-signed) → apply on Hedera
 *
 * The checkpoint path is a small state machine in which every stage is completed once and
 * retried until it succeeds. Its first stage is the safe stop: until 0G has returned a decision
 * the checkpoint is PENDING, nothing is attested, and neither Arkiv's decided record nor the
 * token on Hedera is touched. There is no code path that produces a decision without 0G.
 */
import type {
  ChainAnchor,
  CheckpointRequest,
  CheckpointResponse,
  DeviceContext,
  ReadingRequest,
  ReadingResponse,
  SignRequest,
  SignatureSubmission,
} from '@pinky/device';
import {
  type Address,
  CheckpointKind,
  Decision,
  type DecisionValue,
  type EpisodeLog,
  type GpsOpening,
  type Hex,
  LotState,
  Outcome,
  type OutcomeName,
  ProtocolError,
  type Thresholds,
  type Venue,
  ZERO_32,
  applyCheckpoint,
  boxContains,
  checkpointKindName,
  concat,
  decodeCheckpoint,
  decodeReading,
  decodeSealEvidence,
  fromHex,
  generateViewKey,
  gpsCommitment,
  isInRange,
  isNoFix,
  lotStateName,
  outcomeName,
  readingsRoot,
  requestIdHash,
  sameAddress,
  sealEpisode,
  secpAddress,
  sha256,
  signDecisionAttestation,
  signLotProfile,
  summarizeReadings,
  toHex,
  venueHashHex,
  verifyAnchorAttestation,
  verifyCheckpoint,
  verifyDeviceCert,
  verifyReading,
} from '@pinky/protocol';
import type { CheckpointInput, ReadingInput } from '@pinky/protocol/arkiv';
import { GEOFENCE_CIRCUIT, GEOFENCE_VK_HASH, proofHash, proveGeofence } from '@pinky/zk';
import type { ArkivAdapter } from './arkiv/adapter';
import { DeviceRefusedError, type SignRequestQueue } from './arkiv/sign-requests';
import type { HederaAdapter } from './hedera/adapter';
import type { CheckpointRecord, DeviceRecord, GatewayStore, LotRecord, ReadingRecord, VenueRecord } from './store';
import { type ZgDecisionClient, ZgUnavailable } from './zg/decision';
import type { EpisodeStore } from './zg/storage';

/** A request the gateway refuses; `status` is the HTTP status it maps to. */
export class GatewayError extends Error {
  readonly status: number;
  readonly detail: Record<string, unknown> | undefined;

  constructor(status: number, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.detail = detail;
  }
}

export type GatewayOptions = {
  /** Signs decision attestations. Registered as the lot's attestor on Hedera. */
  attestorKey: Hex;
  /** Registry key: signs lot profiles (the same key that writes registry entities on Arkiv). */
  registryKey: Hex;
  /** Generate geofence proofs. Off is the plan's last scope cut. Default on. */
  geofenceProofs?: boolean;
  /** Readings published per Arkiv transaction. */
  readingBatchSize?: number;
  /** A reading's freshness anchor may be at most this many blocks old when it arrives. */
  maxAnchorAgeBlocks?: number;
  /** Backoff between attempts of a stage that failed. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Gas money for device wallets on Arkiv. */
  deviceTopUp?: { minimumWei: bigint; topUpWei: bigint };
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

export type NewLot = Thresholds & {
  assetId: string;
  title: string;
  device: Address;
  units: number;
  unitValueCents: number;
  /** Planned end of the shipment, unix seconds. */
  endsAt: number;
  disputeWindowS: number;
  /** Receives the units when custody is first accepted. */
  depositor?: Address;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

export class Gateway {
  readonly attestor: Address;
  readonly #options: Required<Pick<GatewayOptions, 'geofenceProofs' | 'readingBatchSize' | 'maxAnchorAgeBlocks' | 'retryBaseMs' | 'retryMaxMs'>> &
    GatewayOptions;
  /** GPS openings, in memory only, until the proof is made. */
  readonly #openings = new Map<Hex, GpsOpening>();
  readonly #busy = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;

  constructor(
    readonly arkiv: ArkivAdapter,
    readonly hedera: HederaAdapter,
    readonly zg: ZgDecisionClient,
    readonly episodes: EpisodeStore,
    readonly signRequests: SignRequestQueue,
    readonly store: GatewayStore,
    options: GatewayOptions,
  ) {
    this.#options = {
      geofenceProofs: true,
      readingBatchSize: 8,
      maxAnchorAgeBlocks: 900,
      retryBaseMs: 2_000,
      retryMaxMs: 30_000,
      ...options,
    };
    this.attestor = secpAddress(fromHex(options.attestorKey, 32));
  }

  #log(event: string, detail?: Record<string, unknown>): void {
    this.#options.log?.(event, detail);
  }

  // -------------------------------------------------------------------------------------------
  // Registry: venues, devices, lots
  // -------------------------------------------------------------------------------------------

  async registerVenue(venue: Venue): Promise<VenueRecord> {
    const existing = this.store.venues[venue.venueId];
    if (existing) return existing;
    const { entityKey } = await this.arkiv.createVenue(venue);
    const record: VenueRecord = { ...venue, venueHash: venueHashHex(venue), entityKey };
    this.store.venues[venue.venueId] = record;
    this.store.touch();
    this.#log('venue.registered', { venueId: venue.venueId });
    return record;
  }

  /** Enrols a device from its certificate, and gives its wallet gas money on Arkiv. */
  async enrollDevice(input: { certBundle: Hex; venueIds: string[]; label: string }): Promise<DeviceRecord> {
    const { cert, walletPublicKey } = verifyDeviceCert(input.certBundle);
    const existing = this.store.device(cert.device);
    if (existing) return existing;
    for (const venueId of input.venueIds) {
      if (!this.store.venues[venueId]) throw new GatewayError(404, `unknown venue ${venueId}`);
    }
    const { entityKey } = await this.arkiv.createDevice({ ...input, registeredAt: nowSeconds() });
    const record: DeviceRecord = {
      address: cert.device.toLowerCase() as Address,
      certBundle: input.certBundle,
      walletPubkey: toHex(walletPublicKey),
      venueIds: input.venueIds,
      label: input.label,
      lastSeq: 0,
      lastCheckpointSeq: 0,
      entityKey,
    };
    this.store.devices[record.address] = record;
    this.store.touch();
    await this.#fundDevice(record.address);
    this.#log('device.enrolled', { device: record.address });
    return record;
  }

  async #fundDevice(device: Address): Promise<void> {
    const { minimumWei, topUpWei } = this.#options.deviceTopUp ?? { minimumWei: 10n ** 16n, topUpWei: 5n * 10n ** 16n };
    await this.arkiv.ensureFunded(device, minimumWei, topUpWei);
  }

  /**
   * Creates a lot end to end: signs its profile, issues its receipt token through ATS,
   * registers it with the custody oracle, and publishes it on Arkiv.
   */
  async createLot(input: NewLot): Promise<LotRecord> {
    const existing = this.store.lots[input.assetId];
    if (existing) return existing;
    const device = this.store.device(input.device);
    if (!device) throw new GatewayError(404, `device ${input.device} is not enrolled`);
    if (Object.values(this.store.lots).some((lot) => lot.device === device.address && lot.endsAt > nowSeconds())) {
      throw new GatewayError(409, 'this device is already assigned to a lot');
    }
    const thresholds: Thresholds = {
      tempMinCenti: input.tempMinCenti,
      tempMaxCenti: input.tempMaxCenti,
      rhMinCenti: input.rhMinCenti,
      rhMaxCenti: input.rhMaxCenti,
    };
    const signedProfile = signLotProfile(
      { assetId: input.assetId, device: device.address, ...thresholds, validUntil: input.endsAt + input.disputeWindowS },
      fromHex(this.#options.registryKey, 32),
    );

    const { token } = await this.hedera.deployReceiptToken({
      assetId: input.assetId,
      units: input.units,
      unitValueCents: input.unitValueCents,
    });
    await this.hedera.registerLot({ assetId: input.assetId, token, device: device.address, attestor: this.attestor, thresholds });
    await this.hedera.allowlistSpender(token, this.hedera.config.market);
    if (input.depositor) await this.hedera.onboardInvestor(token, input.depositor);

    const { entityKey } = await this.arkiv.createLot({
      title: input.title,
      signedProfile,
      hederaChainId: this.hedera.config.chainId,
      token,
      oracle: this.hedera.config.oracle,
      market: this.hedera.config.market,
      attestor: this.attestor,
      gateway: this.arkiv.gateway,
      units: input.units,
      endsAt: input.endsAt,
      disputeWindowS: input.disputeWindowS,
    });

    const record: LotRecord = {
      ...thresholds,
      assetId: input.assetId,
      title: input.title,
      device: device.address,
      signedProfile,
      token,
      units: input.units,
      unitValueCents: input.unitValueCents,
      endsAt: input.endsAt,
      disputeWindowS: input.disputeWindowS,
      viewKey: generateViewKey(),
      ...(input.depositor ? { depositor: input.depositor.toLowerCase() as Address } : {}),
      issued: false,
      entityKey,
    };
    this.store.lots[record.assetId] = record;
    this.store.touch();
    this.#log('lot.created', { assetId: record.assetId, token });
    return record;
  }

  #lot(assetId: string): LotRecord {
    const lot = this.store.lots[assetId];
    if (!lot) throw new GatewayError(404, `unknown lot ${assetId}`);
    return lot;
  }

  async onboardInvestor(assetId: string, investor: Address): Promise<void> {
    await this.hedera.onboardInvestor(this.#lot(assetId).token, investor);
    this.#log('investor.onboarded', { assetId, investor });
  }

  /** The inspector clears a breach. Everything the device has reported so far is covered. */
  async release(assetId: string, inspectionRef: Hex): Promise<Hex> {
    const lot = this.#lot(assetId);
    const txHash = await this.hedera.release(assetId, inspectionRef, this.store.device(lot.device)?.lastSeq ?? 0);
    this.#log('lot.released', { assetId, txHash });
    return txHash;
  }

  // -------------------------------------------------------------------------------------------
  // Device API
  // -------------------------------------------------------------------------------------------

  #device(address: string): DeviceRecord {
    const device = this.store.device(address);
    if (!device) throw new GatewayError(403, `device ${address} is not enrolled`);
    return device;
  }

  async context(deviceAddress: Address): Promise<DeviceContext> {
    const device = this.#device(deviceAddress);
    const lot = Object.values(this.store.lots).find((candidate) => candidate.device === device.address);
    return {
      time: nowSeconds(),
      arkiv: { chainId: this.arkiv.chain.id, anchor: await this.arkiv.anchor() },
      profile: lot?.signedProfile ?? null,
    };
  }

  /** Checks a freshness anchor names a real, recent block and returns its number. */
  async #anchorBlock(blockhash: Hex): Promise<number> {
    const number = await this.arkiv.blockNumberOf(blockhash);
    if (number === undefined) throw new GatewayError(400, 'the freshness anchor is not a block of the Arkiv chain');
    const latest = (await this.arkiv.anchor()).blockNumber;
    if (latest - number > this.#options.maxAnchorAgeBlocks) {
      throw new GatewayError(400, `the freshness anchor is ${latest - number} blocks old`);
    }
    return number;
  }

  async acceptReading(request: ReadingRequest): Promise<ReadingResponse> {
    const verified = this.#verify(() => verifyReading(request));
    const { reading } = verified;
    const digest = toHex(verified.digest);
    const device = this.#device(reading.device);
    if (this.store.readings[digest]) return { digest, accepted: true, duplicate: true };

    const lot = this.#lot(reading.assetId);
    if (lot.device !== device.address) throw new GatewayError(403, 'this device is not assigned to that lot');
    if (this.store.readingsInWindow(device.address, reading.seq, reading.seq).length > 0) {
      throw new GatewayError(409, `the device already sent a different reading with seq ${reading.seq}`);
    }
    const anchorBlock = await this.#anchorBlock(reading.blockhash);

    // The opening is only useful, and only kept, if it really opens the signed commitment.
    let venueId: string | undefined;
    if (request.opening) {
      const opening: GpsOpening = {
        latUnits: request.opening.latUnits,
        lonUnits: request.opening.lonUnits,
        salt: fromHex(request.opening.salt, 32),
      };
      if (toHex(this.#verify(() => gpsCommitment(opening))) !== reading.gpsCommitment) {
        throw new GatewayError(400, 'the GPS opening does not match the signed commitment');
      }
      if (!isNoFix(opening)) {
        venueId = device.venueIds.find((id) => boxContains(this.store.venues[id]!.box, opening.latUnits, opening.lonUnits));
        if (venueId && this.#options.geofenceProofs) this.#openings.set(digest, opening);
      }
    }

    const record: ReadingRecord = {
      digest,
      payload: request.payload,
      sig: request.sig,
      assetId: reading.assetId,
      device: device.address,
      seq: reading.seq,
      ts: reading.ts,
      inRange: isInRange(lot, reading.tempCenti, reading.rhCenti),
      anchorBlock,
      ...(venueId ? { venueId } : {}),
      arkiv: 'queued',
      proof: venueId && this.#options.geofenceProofs ? 'queued' : 'none',
    };
    this.store.readings[digest] = record;
    device.lastSeq = Math.max(device.lastSeq, reading.seq);
    this.store.touch();
    this.#log('reading.accepted', { device: device.address, seq: reading.seq, inRange: record.inRange, venueId });
    this.#kick();
    return { digest, accepted: true };
  }

  async acceptCheckpoint(request: CheckpointRequest): Promise<CheckpointResponse> {
    const verified = this.#verify(() => verifyCheckpoint(request));
    const { checkpoint } = verified;
    const id = toHex(verified.digest);
    const existing = this.store.checkpoints[id];
    if (existing) return this.#response(existing);

    const device = this.#device(checkpoint.device);
    const lot = this.#lot(checkpoint.assetId);
    if (lot.device !== device.address) throw new GatewayError(403, 'this device is not assigned to that lot');
    if (checkpoint.seq <= device.lastCheckpointSeq) {
      throw new GatewayError(409, `checkpoint seq ${checkpoint.seq} is not after ${device.lastCheckpointSeq}`);
    }
    await this.#anchorBlock(checkpoint.blockhash);

    // The bundle must be exactly the readings the gateway holds for that window.
    const window = this.store.readingsInWindow(device.address, checkpoint.firstSeq, checkpoint.lastSeq);
    const root = window.length > 0 ? toHex(readingsRoot(window.map((r) => fromHex(r.digest, 32)))) : undefined;
    if (window.length !== checkpoint.readingCount || root !== checkpoint.readingsRoot) {
      const have = new Set(window.map((r) => r.seq));
      const missing: number[] = [];
      for (let seq = checkpoint.firstSeq; seq <= checkpoint.lastSeq && missing.length < 500; seq++) {
        if (!have.has(seq)) missing.push(seq);
      }
      throw new GatewayError(409, 'the gateway does not hold every reading this checkpoint bundles', { missing });
    }

    // Seal evidence: the record must hash to what was signed, and the photo to what it names.
    const sealBytes = new Uint8Array(Buffer.from(request.seal, 'base64'));
    if (toHex(sha256(sealBytes)) !== checkpoint.sealHash) throw new GatewayError(400, 'seal evidence does not match the signed hash');
    const evidence = this.#verify(() => decodeSealEvidence(sealBytes));
    if (evidence.photo) {
      const photo = request.photo ? new Uint8Array(Buffer.from(request.photo.data, 'base64')) : undefined;
      if (!photo || toHex(sha256(photo)) !== evidence.photo.sha256) {
        throw new GatewayError(400, 'the seal photo is missing or does not match the evidence record');
      }
    }

    // Venue anchor: must be the registered anchor of a venue this device is enrolled at.
    let anchor: CheckpointRecord['anchor'];
    if (request.anchor) {
      const attested = this.#verify(() => verifyAnchorAttestation(request.anchor!));
      const venue = this.store.venues[attested.attestation.venueId];
      if (
        toHex(attested.digest) !== checkpoint.anchorDigest ||
        !sameAddress(attested.attestation.device, device.address) ||
        attested.attestation.blockhash !== checkpoint.blockhash ||
        !venue?.anchor ||
        !sameAddress(attested.signer, venue.anchor) ||
        !device.venueIds.includes(venue.venueId)
      ) {
        throw new GatewayError(400, 'the venue anchor attestation is not valid for this checkpoint');
      }
      anchor = { ...request.anchor, venueId: venue.venueId };
    } else if (checkpoint.anchorDigest !== ZERO_32) {
      throw new GatewayError(400, 'the checkpoint commits to an anchor attestation that was not sent');
    }

    // Refuse a handoff that cannot happen in the lot's current state, before asking anyone.
    const onChain = await this.hedera.lot(lot.assetId);
    if (!onChain) throw new GatewayError(409, 'the lot is not registered with the custody oracle');
    const possible = applyCheckpoint({
      state: onChain.state,
      breachOpen: false,
      kind: checkpoint.kind,
      decision: Decision.ACCEPT_CUSTODY,
      breachProven: false,
    });
    if (!possible.ok) throw new GatewayError(409, possible.reason);

    const record: CheckpointRecord = {
      id,
      assetId: lot.assetId,
      device: device.address,
      payload: request.payload,
      sig: request.sig,
      sealRecord: new TextDecoder().decode(sealBytes),
      ...(request.photo ? { photo: { mime: request.photo.mime, base64: request.photo.data } } : {}),
      ...(anchor ? { anchor } : {}),
      ...(anchor?.venueId ?? window.at(-1)?.venueId ? { venueId: anchor?.venueId ?? window.at(-1)!.venueId } : {}),
      receivedAt: nowSeconds(),
      stage: 'AWAITING_DECISION',
      failedAttempts: [],
      nextAttemptAt: 0,
      pendingPublished: false,
    };
    this.store.checkpoints[id] = record;
    device.lastSeq = Math.max(device.lastSeq, checkpoint.seq);
    device.lastCheckpointSeq = checkpoint.seq;
    this.store.touch();
    this.#log('checkpoint.received', { id, kind: checkpointKindName(checkpoint.kind), assetId: lot.assetId });
    this.#kick();
    return this.#response(record);
  }

  checkpointStatus(deviceAddress: Address, id: Hex): CheckpointResponse {
    const record = this.store.checkpoints[id.toLowerCase()];
    if (!record || record.device !== deviceAddress.toLowerCase()) throw new GatewayError(404, 'unknown checkpoint');
    return this.#response(record);
  }

  /** What the device is told. PENDING until 0G has decided: never anything else by default. */
  #response(record: CheckpointRecord): CheckpointResponse {
    if (!record.decision || !record.outcome) {
      const last = record.failedAttempts.at(-1);
      return {
        checkpointId: record.id,
        status: 'PENDING',
        reason: last ? `no decision yet: ${last.error}` : 'waiting for the 0G decision',
      };
    }
    return {
      checkpointId: record.id,
      status: record.outcome,
      decision: record.decision.decision,
      reason: record.decision.reason,
    };
  }

  pendingSignRequests(deviceAddress: Address): SignRequest[] {
    return this.signRequests.pendingFor(this.#device(deviceAddress).address);
  }

  submitSignature(deviceAddress: Address, submission: SignatureSubmission): boolean {
    return this.signRequests.submit(this.#device(deviceAddress).address, submission);
  }

  #verify<T>(check: () => T): T {
    try {
      return check();
    } catch (error) {
      if (error instanceof ProtocolError) throw new GatewayError(400, error.message);
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Workers
  // -------------------------------------------------------------------------------------------

  /** Starts the background loop that publishes, proves and advances checkpoints. */
  start(intervalMs = 500): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#kick(), intervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#ticking;
    this.store.flush();
  }

  #kick(): void {
    this.#ticking ??= this.tick()
      .catch((error) => this.#log('tick.error', { error: (error as Error).message }))
      .finally(() => {
        this.#ticking = undefined;
      });
  }

  /** One pass: start whatever is due and not already running. Does not wait for it to finish. */
  async tick(): Promise<void> {
    for (const device of Object.values(this.store.devices)) {
      this.#exclusive(`publish:${device.address}`, () => this.#publishReadings(device));
    }
    this.#exclusive('prove', () => this.#proveNext());
    const now = Date.now();
    for (const record of Object.values(this.store.checkpoints)) {
      if (record.stage === 'APPLIED' || record.stage === 'FAILED' || record.nextAttemptAt > now) continue;
      this.#exclusive(`checkpoint:${record.id}`, () => this.#advance(record));
    }
  }

  /** Runs a task unless one with the same key is already running. */
  #exclusive(key: string, task: () => Promise<void>): void {
    if (this.#busy.has(key)) return;
    this.#busy.add(key);
    task()
      .catch((error) => this.#log('worker.error', { key, error: (error as Error).message }))
      .finally(() => this.#busy.delete(key));
  }

  /** Resolves when nothing is queued or running (for tests and scripted runs). */
  async idle(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const work =
        this.#busy.size > 0 ||
        Object.values(this.store.readings).some((r) => r.arkiv === 'queued' || r.proof === 'queued') ||
        Object.values(this.store.checkpoints).some((c) => c.stage !== 'APPLIED' && c.stage !== 'FAILED' && c.stage !== 'AWAITING_DECISION');
      if (!work) return;
      if (Date.now() > deadline) throw new Error('gateway did not become idle in time');
      this.#kick();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  #lifetimes(lot: LotRecord) {
    return { endsAt: lot.endsAt, disputeWindowS: lot.disputeWindowS };
  }

  #readingInput(record: ReadingRecord): ReadingInput {
    return {
      reading: decodeReading(fromHex(record.payload)),
      digest: record.digest,
      sig: record.sig,
      inRange: record.inRange,
      anchorBlock: record.anchorBlock,
      ...(record.venueId ? { venueHash: this.store.venues[record.venueId]!.venueHash } : {}),
    };
  }

  async #publishReadings(device: DeviceRecord): Promise<void> {
    const queued = Object.values(this.store.readings)
      .filter((r) => r.device === device.address && r.arkiv === 'queued')
      .sort((a, b) => a.seq - b.seq)
      .slice(0, this.#options.readingBatchSize);
    if (queued.length === 0) return;
    const lot = this.#lot(queued[0]!.assetId);
    const batch = queued.filter((r) => r.assetId === lot.assetId);
    try {
      const { entityKeys, txHash } = await this.arkiv.createReadings(
        device.address,
        batch.map((r) => this.#readingInput(r)),
        this.#lifetimes(lot),
      );
      batch.forEach((record, index) => {
        record.arkiv = 'published';
        record.entityKey = entityKeys[index];
      });
      this.#log('readings.published', { device: device.address, count: batch.length, txHash });
    } catch (error) {
      if (error instanceof DeviceRefusedError) {
        // The device will not sign this; retrying cannot change that. Keep it visible.
        for (const record of batch) {
          record.arkiv = 'refused';
          record.arkivError = error.message;
        }
        this.#log('readings.refused', { device: device.address, error: error.message });
      } else {
        this.#log('readings.retry', { device: device.address, error: (error as Error).message });
      }
    }
    this.store.touch();
  }

  async #proveNext(): Promise<void> {
    const record = Object.values(this.store.readings)
      .filter((r) => r.proof === 'queued')
      .sort((a, b) => a.seq - b.seq)[0];
    if (!record) return;
    const opening = this.#openings.get(record.digest);
    const device = this.store.device(record.device);
    const venue = record.venueId ? this.store.venues[record.venueId] : undefined;
    if (!opening || !device || !venue) {
      // The opening is gone (the gateway restarted): the proof can no longer be made.
      record.proof = 'failed';
      record.proofError = 'the GPS opening is no longer available';
      this.store.touch();
      return;
    }
    try {
      const reading = decodeReading(fromHex(record.payload));
      const proof = await proveGeofence(
        { digest: fromHex(record.digest, 32), publicKey: fromHex(device.walletPubkey, 64), box: venue.box },
        { payload: fromHex(record.payload), signature: fromHex(record.sig), opening },
      );
      await this.arkiv.createGeoProof(
        {
          assetId: record.assetId,
          deviceId: record.device,
          venueId: venue.venueId,
          venueHash: venue.venueHash,
          readingDigest: record.digest,
          seq: reading.seq,
          ts: reading.ts,
          proofHash: proofHash(proof.proof),
          circuit: GEOFENCE_CIRCUIT,
          vkHash: GEOFENCE_VK_HASH,
          proof: proof.proof,
        },
        this.#lifetimes(this.#lot(record.assetId)),
      );
      record.proof = 'published';
      this.#openings.delete(record.digest);
      this.#log('geoproof.published', { seq: record.seq, venueId: venue.venueId });
    } catch (error) {
      record.proof = 'failed';
      record.proofError = (error as Error).message;
      this.#openings.delete(record.digest);
      this.#log('geoproof.failed', { seq: record.seq, error: record.proofError });
    }
    this.store.touch();
  }

  #backoff(record: CheckpointRecord, attempts: number): void {
    const delay = Math.min(this.#options.retryBaseMs * 2 ** Math.max(attempts - 1, 0), this.#options.retryMaxMs);
    record.nextAttemptAt = Date.now() + delay;
  }

  /** Completes the next stage of a checkpoint, or schedules a retry. */
  async #advance(record: CheckpointRecord): Promise<void> {
    const lot = this.#lot(record.assetId);
    const checkpoint = decodeCheckpoint(fromHex(record.payload));
    const window = this.store.readingsInWindow(record.device, checkpoint.firstSeq, checkpoint.lastSeq);
    try {
      if (!record.pendingPublished && record.stage === 'AWAITING_DECISION') {
        // Best effort and not awaited: a PENDING record so readers see the handoff was attempted.
        this.#exclusive(`pending:${record.id}`, () => this.#publishPending(record, lot));
      }

      if (record.stage === 'AWAITING_DECISION') {
        const onChain = await this.hedera.lot(lot.assetId);
        if (!onChain) throw new Error('the lot is not registered with the custody oracle');
        const readings = window.map((r) => decodeReading(fromHex(r.payload)));
        const evidence = decodeSealEvidence(new TextEncoder().encode(record.sealRecord));
        let decision;
        try {
          decision = await this.zg.decide({
            assetId: lot.assetId,
            kind: checkpointKindName(checkpoint.kind),
            state: lotStateName(onChain.state),
            summary: summarizeReadings(readings, lot),
            seal: evidence,
            ...(record.photo
              ? { photo: { mime: record.photo.mime, bytes: new Uint8Array(Buffer.from(record.photo.base64, 'base64')) } }
              : {}),
            anchor: { present: Boolean(record.anchor), ...(record.anchor ? { venueId: record.anchor.venueId } : {}) },
            geofence: { proven: window.at(-1)?.proof === 'published', ...(record.venueId ? { venueId: record.venueId } : {}) },
          });
        } catch (error) {
          if (!(error instanceof ZgUnavailable)) throw error;
          // Safe stop. No decision exists, so nothing downstream runs. Try again later.
          record.failedAttempts.push({ at: nowSeconds(), error: error.message, kind: error.kind });
          this.#backoff(record, record.failedAttempts.length);
          this.store.touch();
          this.#log('checkpoint.pending', { id: record.id, kind: error.kind, error: error.message });
          return;
        }

        // A breach is a fact about signed readings, established here and re-checked on chain.
        const breachRecord = window.find((r) => !r.inRange && r.seq > onChain.clearedSeq);
        const breach = Boolean(breachRecord);
        const policy = applyCheckpoint({
          state: onChain.state,
          breachOpen: onChain.breachOpen,
          kind: checkpoint.kind,
          decision: Decision[decision.decision],
          breachProven: breach,
        });
        record.decision = { ...decision, decidedAt: nowSeconds() };
        record.breach = breach;
        record.stateBefore = lotStateName(onChain.state);
        if (breachRecord) record.breachReading = { payload: breachRecord.payload, sig: breachRecord.sig };
        if (!policy.ok) {
          record.stage = 'FAILED';
          record.error = `the decision cannot be applied: ${policy.reason}`;
          this.store.touch();
          this.#log('checkpoint.failed', { id: record.id, error: record.error });
          return;
        }
        record.outcome = outcomeName(policy.outcome) as CheckpointRecord['outcome'];
        record.stage = 'DECIDED';
        this.store.touch();
        this.#log('checkpoint.decided', {
          id: record.id,
          decision: decision.decision,
          outcome: record.outcome,
          requestId: decision.requestId,
          source: decision.source,
        });
      }

      if (record.stage === 'DECIDED') {
        const decision = record.decision!;
        const episode: EpisodeLog = {
          v: 1,
          type: 'pinky.episode',
          assetId: lot.assetId,
          device: record.device,
          thresholds: {
            tempMinCenti: lot.tempMinCenti,
            tempMaxCenti: lot.tempMaxCenti,
            rhMinCenti: lot.rhMinCenti,
            rhMaxCenti: lot.rhMaxCenti,
          },
          checkpoint: { id: record.id, payload: record.payload, sig: record.sig },
          seal: { record: record.sealRecord, ...(record.photo ? { photo: record.photo } : {}) },
          ...(record.anchor ? { anchor: { payload: record.anchor.payload, sig: record.anchor.sig } } : {}),
          readings: window.map(({ payload, sig }) => ({ payload, sig })),
          summary: summarizeReadings(window.map((r) => decodeReading(fromHex(r.payload))), lot),
          failedAttempts: record.failedAttempts.map(({ at, error }) => ({ at, error })),
          decision: {
            source: decision.source,
            requestId: decision.requestId,
            model: decision.model,
            ...(decision.provider ? { provider: decision.provider } : {}),
            ...(decision.teeVerified !== undefined ? { teeVerified: decision.teeVerified } : {}),
            decision: decision.decision,
            reason: decision.reason,
            prompt: decision.prompt,
            rawAnswer: decision.rawAnswer,
            latencyMs: decision.latencyMs,
            decidedAt: decision.decidedAt,
          },
          policy: { stateBefore: record.stateBefore!, breach: record.breach!, outcome: record.outcome! },
        };
        // The episode must be on 0G Storage before anything refers to it.
        const stored = await this.episodes.put(sealEpisode(episode, lot.viewKey));
        record.episodeRoot = stored.root;
        if (stored.txHash) record.episodeTx = stored.txHash;
        record.attestation = signDecisionAttestation(
          {
            checkpointDigest: record.id,
            decision: Decision[decision.decision],
            breach: record.breach!,
            requestIdHash: requestIdHash(decision.requestId),
            episodeRoot: stored.root,
            decidedAt: decision.decidedAt,
          },
          fromHex(this.#options.attestorKey, 32),
        );
        record.stage = 'ATTESTED';
        this.store.touch();
        this.#log('checkpoint.attested', { id: record.id, episodeRoot: stored.root, store: this.episodes.kind });
      }

      if (record.stage === 'ATTESTED') {
        const { entityKey } = await this.arkiv.createCheckpoint(record.device, this.#decidedInput(record), this.#lifetimes(lot));
        record.arkivKey = entityKey;
        record.stage = 'PUBLISHED';
        this.store.touch();
        this.#log('checkpoint.published', { id: record.id, entityKey });
      }

      if (record.stage === 'PUBLISHED') {
        const applied = await this.hedera.submitCheckpoint({
          checkpoint: record.payload,
          deviceSig: record.sig,
          attestation: record.attestation!.payload,
          attestorSig: record.attestation!.sig,
          ...(record.breachReading ? { breachReading: record.breachReading } : {}),
        });
        record.hederaTx = applied.txHash;
        if (outcomeName(applied.outcome) !== record.outcome) {
          record.error = `Hedera applied ${outcomeName(applied.outcome)}, expected ${record.outcome}`;
        }
        // The receipt is issued the first time a venue accepts custody of the goods.
        if (applied.stateAfter === LotState.IN_CUSTODY && applied.outcome === Outcome.ACCEPTED && !lot.issued && lot.depositor) {
          await this.hedera.onboardInvestor(lot.token, lot.depositor);
          await this.hedera.issue(lot.token, lot.depositor, lot.units);
          lot.issued = true;
          this.#log('receipt.issued', { assetId: lot.assetId, to: lot.depositor, units: lot.units });
        }
        record.stage = 'APPLIED';
        this.store.touch();
        this.#log('checkpoint.applied', { id: record.id, outcome: record.outcome, txHash: applied.txHash });
      }
    } catch (error) {
      if (error instanceof DeviceRefusedError) {
        record.stage = 'FAILED';
        record.error = error.message;
        this.#log('checkpoint.failed', { id: record.id, error: error.message });
      } else {
        // Transient: keep the stage, try again later. A decided checkpoint is never re-decided.
        record.error = (error as Error).message;
        this.#backoff(record, 1);
        this.#log('checkpoint.retry', { id: record.id, stage: record.stage, error: record.error });
      }
      this.store.touch();
    }
  }

  #baseInput(record: CheckpointRecord) {
    const checkpoint = decodeCheckpoint(fromHex(record.payload));
    const venueHash = record.venueId ? this.store.venues[record.venueId]?.venueHash : undefined;
    return {
      checkpoint,
      checkpointId: record.id,
      payload: record.payload,
      sig: record.sig,
      attestor: this.attestor,
      ...(venueHash ? { venueHash } : {}),
      ...(record.anchor
        ? { anchorAttestation: toHex(concat(fromHex(record.anchor.payload), fromHex(record.anchor.sig))) }
        : {}),
    };
  }

  #decidedInput(record: CheckpointRecord): CheckpointInput {
    const decision = record.decision!;
    const attestation = record.attestation!;
    return {
      ...this.#baseInput(record),
      outcome: record.outcome as OutcomeName,
      reason: decision.reason,
      attestation: {
        checkpointDigest: record.id,
        decision: Decision[decision.decision] as DecisionValue,
        breach: record.breach!,
        requestIdHash: requestIdHash(decision.requestId),
        episodeRoot: record.episodeRoot!,
        decidedAt: decision.decidedAt,
      },
      attestationPayload: attestation.payload,
      attestorSig: attestation.sig,
      zg: {
        source: decision.source,
        requestId: decision.requestId,
        model: decision.model,
        ...(decision.provider ? { provider: decision.provider } : {}),
        ...(typeof decision.teeVerified === 'boolean' ? { teeVerified: decision.teeVerified } : {}),
      },
      ...(record.breachReading
        ? { breachReading: toHex(concat(fromHex(record.breachReading.payload), fromHex(record.breachReading.sig))) }
        : {}),
    };
  }

  /** Publishes the PENDING record: "a handoff was attempted and is not accepted". */
  async #publishPending(record: CheckpointRecord, lot: LotRecord): Promise<void> {
    if (record.pendingPublished || record.stage !== 'AWAITING_DECISION') return;
    const attestation = {
      checkpointDigest: record.id,
      decision: Decision.PENDING,
      breach: false,
      requestIdHash: ZERO_32,
      episodeRoot: ZERO_32,
      decidedAt: record.receivedAt,
    };
    const signed = signDecisionAttestation(attestation, fromHex(this.#options.attestorKey, 32));
    try {
      await this.arkiv.createCheckpoint(
        record.device,
        {
          ...this.#baseInput(record),
          outcome: 'PENDING',
          reason: 'Waiting for the 0G decision. The handoff is not accepted.',
          attestation,
          attestationPayload: signed.payload,
          attestorSig: signed.sig,
          zg: { source: 'none' },
        },
        this.#lifetimes(lot),
      );
      record.pendingPublished = true;
      this.store.touch();
    } catch (error) {
      // A decision may have arrived meanwhile (the device then refuses a late PENDING): fine.
      this.#log('checkpoint.pending-record-skipped', { id: record.id, error: (error as Error).message });
      record.pendingPublished = true;
      this.store.touch();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------------------------

  /** A lot's view key, for parties entitled to its raw readings. */
  viewKey(assetId: string): Hex {
    return this.#lot(assetId).viewKey;
  }

  status() {
    const readings = Object.values(this.store.readings);
    const checkpoints = Object.values(this.store.checkpoints);
    const count = <T>(items: T[], test: (item: T) => boolean) => items.filter(test).length;
    return {
      devices: Object.keys(this.store.devices).length,
      lots: Object.keys(this.store.lots).length,
      readings: {
        total: readings.length,
        queued: count(readings, (r) => r.arkiv === 'queued'),
        published: count(readings, (r) => r.arkiv === 'published'),
        refused: count(readings, (r) => r.arkiv === 'refused'),
        proofsPublished: count(readings, (r) => r.proof === 'published'),
        proofsFailed: count(readings, (r) => r.proof === 'failed'),
      },
      checkpoints: checkpoints.map((c) => ({
        id: c.id,
        assetId: c.assetId,
        stage: c.stage,
        outcome: c.outcome ?? 'PENDING',
        failedAttempts: c.failedAttempts.length,
        lastError: c.error ?? c.failedAttempts.at(-1)?.error,
      })),
      signRequests: this.signRequests.size,
    };
  }
}

export type { ChainAnchor };
export { CheckpointKind };
