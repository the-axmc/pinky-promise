/**
 * The whole flow, end to end, on the local stack: a simulated device talks to the gateway over
 * HTTP; the gateway publishes to the Arkiv node through the unmodified SDK, asks the (stand-in)
 * decision endpoint, stores episode logs, and drives the real ATS token through the oracle.
 *
 * Journey: origin warehouse → road (cooling fails) → destination dock, with a 0G outage at the
 * dock to exercise the safe stop.
 */
import { createPublicClient } from '@arkiv-network/sdk';
import {
  Device,
  DeviceRunner,
  HttpGatewayLink,
  MemoryStorage,
  SimulatedAnchor,
  type SimulatedHardware,
  createSimulatedHardware,
  generateIdentity,
} from '@pinky/device';
import {
  CheckpointKind,
  type Hex,
  LotState,
  checkpointDigest,
  decodeReading,
  decodeSealEvidence,
  fromHex,
  openEpisode,
  secpVerify,
  sha256,
  summarizeReadings,
  toHex,
  verifyCheckpoint,
  verifyDecisionAttestation,
  verifyDeviceCert,
  verifyReading,
} from '@pinky/protocol';
import {
  fetchCheckpoints,
  fetchDevice,
  fetchGeoProofs,
  fetchLot,
  fetchReadings,
  fetchVenues,
  latestPerCheckpoint,
} from '@pinky/protocol/arkiv';
import { verifyGeofence } from '@pinky/zk';
import { http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalStack, startLocalStack } from '../src/local';

const ASSET = 'LOT-42';
const ORIGIN = { venueId: 'WH-MUM-01', name: 'Mumbai cold store', latDeg: 19.076, lonDeg: 72.8777 };
const DOCK = { venueId: 'DK-PNQ-02', name: 'Pune receiving dock', latDeg: 18.5204, lonDeg: 73.8567 };

let stack: LocalStack;
let hardware: SimulatedHardware;
let device: Device;
let runner: DeviceRunner;
let stopSigning: () => Promise<void>;
let reader: ReturnType<typeof createPublicClient>;
const anchors = {
  origin: new SimulatedAnchor(`0x${'31'.repeat(32)}`),
  dock: new SimulatedAnchor(`0x${'32'.repeat(32)}`),
};
let nearby: SimulatedAnchor | null = null;

const admin = async (path: string, body?: unknown) => {
  const response = await fetch(`${stack.url}/v1/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${stack.adminToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as any;
  if (!response.ok) throw new Error(`admin ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
};

/** Moves the simulated device: position, which anchor is in radio range, and the climate. */
function place(where: 'origin' | 'road' | 'dock', tempCenti = 450) {
  const spot = { origin: [19.0761, 72.8778], road: [18.8, 73.3], dock: [18.5205, 73.8568] }[where] as [
    number,
    number,
  ];
  hardware.position.set({ latDeg: spot[0], lonDeg: spot[1] });
  hardware.climate.set(tempCenti, 4500);
  nearby = where === 'road' ? null : anchors[where];
  nearby?.setVenue(where === 'origin' ? ORIGIN.venueId : DOCK.venueId);
}

/** Sends a checkpoint and waits until it is decided and fully applied. */
async function handoff(kind: (typeof CheckpointKind)[keyof typeof CheckpointKind]) {
  const sent = await runner.checkpoint(kind);
  const decided = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 60_000 });
  await stack.gateway.idle();
  return decided;
}

const chainLot = async () => (await stack.gateway.hedera.lot(ASSET))!;
const records = async () =>
  latestPerCheckpoint(await fetchCheckpoints(reader, { assetId: ASSET, device: device.address }));

beforeAll(async () => {
  stack = await startLocalStack({ gateway: { retryBaseMs: 300, retryMaxMs: 800 } });
  reader = createPublicClient({ chain: stack.arkiv.chain, transport: http() });

  hardware = createSimulatedHardware(generateIdentity(), {
    anchor: { attest: async (request) => (nearby ? nearby.attest(request) : null) },
  });
  device = await Device.create(hardware, new MemoryStorage(), {
    registry: stack.registry,
    attestor: stack.publicConfig.attestor,
    arkivChainId: stack.arkiv.chainId,
  });
  runner = new DeviceRunner(device, new HttpGatewayLink(stack.url));

  await admin('/venues', { ...ORIGIN, radiusM: 150, anchor: anchors.origin.address });
  await admin('/venues', { ...DOCK, radiusM: 150, anchor: anchors.dock.address });
  await admin('/devices', {
    certBundle: await device.certificate(),
    venueIds: [ORIGIN.venueId, DOCK.venueId],
    label: 'Pocket sensor #1',
  });
  const now = Math.floor(Date.now() / 1000);
  await admin('/lots', {
    assetId: ASSET,
    title: 'Cold-chain pharma pallet #42',
    device: device.address,
    tempMinCenti: 200,
    tempMaxCenti: 800,
    rhMinCenti: 2000,
    rhMaxCenti: 7000,
    units: 100,
    unitValueCents: 1800,
    endsAt: now + 3 * 86_400,
    disputeWindowS: 14 * 86_400,
    depositor: stack.hedera.accounts.depositor.address,
  });
  stopSigning = runner.startSigning(100);
}, 180_000);

afterAll(async () => {
  await stopSigning?.();
  await stack?.stop();
});

describe('end to end on the local stack', () => {
  it('assigns the lot to the device through a registry-signed profile', async () => {
    await runner.sync();
    expect(device.profile).toMatchObject({ assetId: ASSET, tempMinCenti: 200, tempMaxCenti: 800 });
    expect((await chainLot()).state).toBe(LotState.REGISTERED);

    const lot = await fetchLot(reader, stack.registry, ASSET);
    expect(lot).toMatchObject({
      deviceId: device.address,
      creator: stack.registry,
      profileSigner: stack.registry,
    });
    expect(lot!.token).toBe((await chainLot()).token);
  });

  it('accepts custody at the origin warehouse and issues the receipt', async () => {
    place('origin');
    await runner.reading();
    await runner.reading();
    const decided = await handoff(CheckpointKind.WAREHOUSE_IN);

    expect(decided).toMatchObject({ status: 'ACCEPTED', decision: 'ACCEPT_CUSTODY' });
    expect(hardware.display.last.state).toBe('ACCEPTED');
    expect((await chainLot()).state).toBe(LotState.IN_CUSTODY);
    const { token } = await chainLot();
    expect(await stack.gateway.hedera.holding(token, stack.hedera.accounts.depositor.address)).toEqual({
      free: 100n,
      frozen: 0n,
      total: 100n,
    });
  }, 120_000);

  it('published the readings on Arkiv as entities the device created', async () => {
    const readings = await fetchReadings(reader, { assetId: ASSET, device: device.address });
    expect(readings.map((r) => r.seq)).toEqual([1, 2]);
    for (const reading of readings) {
      expect(reading).toMatchObject({ creator: device.address, readonly: true, inRange: true });
      expect(secpVerify(fromHex(reading.digest), fromHex(reading.sig), device.address)).toBe(true);
    }
    // Raw temperature and humidity are not part of the public record at all.
    expect(Object.keys(readings[0]!).some((key) => /temp|rh|humid/i.test(key))).toBe(false);
  });

  it('proved each warehouse reading was inside the venue, without revealing where', async () => {
    const proofs = await fetchGeoProofs(reader, { assetId: ASSET, gateway: stack.publicConfig.gateway });
    expect(proofs.map((p) => p.seq)).toEqual([1, 2]);

    // A buyer verifies with public data only: the reading's digest, the device key from its
    // certificate and the venue's published box.
    const enrolled = await fetchDevice(reader, stack.registry, device.address);
    const { walletPublicKey } = verifyDeviceCert(enrolled!.hwCert);
    const venue = (await fetchVenues(reader, stack.registry)).find((v) => v.venueId === ORIGIN.venueId)!;
    for (const proof of proofs) {
      expect(proof.venueHash).toBe(venue.venueHash);
      const statement = { digest: fromHex(proof.readingDigest), publicKey: walletPublicKey, box: venue.box };
      expect(await verifyGeofence(statement, fromHex(proof.proof))).toBe(true);
    }
    const dock = (await fetchVenues(reader, stack.registry)).find((v) => v.venueId === DOCK.venueId)!;
    const wrongVenue = {
      digest: fromHex(proofs[0]!.readingDigest),
      publicKey: walletPublicKey,
      box: dock.box,
    };
    expect(await verifyGeofence(wrongVenue, fromHex(proofs[0]!.proof))).toBe(false);
  }, 60_000);

  it('recorded the decision with its request id, and a replayable episode log', async () => {
    const [record] = await records();
    expect(record).toMatchObject({
      kind: 'WAREHOUSE_IN',
      decision: 'ACCEPT_CUSTODY',
      outcome: 'ACCEPTED',
      breach: false,
      zgSource: 'dev-mock', // the stand-in is never recorded as a 0G decision
      creator: device.address,
      attestor: stack.publicConfig.attestor,
    });
    expect(record!.zgRequestId).toMatch(/^mock-/);
    expect(verifyDecisionAttestation({ payload: record!.attestation, sig: record!.attestorSig }).signer).toBe(
      stack.publicConfig.attestor,
    );

    // Replay: download the episode by its root, decrypt with the lot's view key, re-verify.
    const { viewKey } = await admin(`/lots/${ASSET}/view-key`);
    const ciphertext = new Uint8Array(
      await (await fetch(`${stack.url}/v1/episodes/${record!.episodeRoot}`)).arrayBuffer(),
    );
    const episode = openEpisode(ciphertext, viewKey);
    expect(episode.decision).toMatchObject({
      requestId: record!.zgRequestId,
      decision: 'ACCEPT_CUSTODY',
      source: 'dev-mock',
    });
    expect(toHex(checkpointDigest(fromHex(episode.checkpoint.payload)))).toBe(record!.checkpointId);
    verifyCheckpoint(episode.checkpoint);
    const raw = episode.readings.map((r) => verifyReading(r).reading);
    expect(raw.map((r) => r.tempCenti)).toEqual([450, 450]); // raw values live only here
    expect(episode.summary).toEqual(summarizeReadings(raw, episode.thresholds));
    const evidence = decodeSealEvidence(new TextEncoder().encode(episode.seal.record));
    expect(evidence.photo!.sha256).toBe(toHex(sha256(Buffer.from(episode.seal.photo!.base64, 'base64'))));
    expect(episode.anchor).toBeDefined();
  });

  it('restricts transfers once the lot leaves the warehouse', async () => {
    await runner.reading();
    expect((await handoff(CheckpointKind.WAREHOUSE_OUT)).status).toBe('ACCEPTED');
    expect((await chainLot()).state).toBe(LotState.IN_TRANSIT);
  }, 120_000);

  it('safe stop: with 0G unreachable the handoff stays PENDING and nothing is touched', async () => {
    place('road', 520);
    await runner.reading();
    place('road', 1260); // cooling fails: 12.6 °C against a 2–8 °C band
    await runner.reading();
    place('dock', 610);
    await runner.reading();

    stack.zg.setMode('down');
    const sent = await runner.checkpoint(CheckpointKind.DOCK_HANDOFF);
    expect(sent.status).toBe('PENDING');
    const stillPending = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 3_000 });

    expect(stillPending.status).toBe('PENDING');
    expect(stillPending.reason).toMatch(/no decision yet.*no_available_provider/);
    expect(hardware.display.last.state).toBe('PENDING');
    const local = stack.gateway.store.checkpoints[sent.checkpointId]!;
    expect(local.stage).toBe('AWAITING_DECISION');
    expect(local.failedAttempts.length).toBeGreaterThanOrEqual(2);
    expect(local.decision).toBeUndefined();
    expect(local.attestation).toBeUndefined();

    // Hedera untouched; Arkiv shows the attempt as PENDING and claims no 0G request.
    expect(await chainLot()).toMatchObject({ state: LotState.IN_TRANSIT, breachOpen: false });
    let record = (await records()).find((r) => r.checkpointId === sent.checkpointId);
    for (let i = 0; !record && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      record = (await records()).find((r) => r.checkpointId === sent.checkpointId);
    }
    if (!record) throw new Error('the PENDING record never appeared on Arkiv');
    expect(record).toMatchObject({ decision: 'PENDING', outcome: 'PENDING', zgSource: 'none' });
    expect(record.zgRequestId).toBeUndefined();
    expect(record.episodeRoot).toBeUndefined();
  }, 120_000);

  it('once 0G answers, rejects the handoff and freezes the receipt on the signed breach', async () => {
    stack.zg.setMode('up');
    const pending = Object.values(stack.gateway.store.checkpoints).find(
      (c) => c.stage === 'AWAITING_DECISION',
    )!;
    const decided = await runner.awaitDecision(pending.id, { timeoutMs: 60_000 });
    await stack.gateway.idle();

    expect(decided).toMatchObject({ status: 'FROZEN', decision: 'REJECT' });
    expect(hardware.display.last.state).toBe('FROZEN');
    expect(await chainLot()).toMatchObject({ state: LotState.FROZEN, breachOpen: true });
    const { token } = await chainLot();
    expect(await stack.gateway.hedera.holding(token, stack.hedera.accounts.depositor.address)).toEqual({
      free: 0n,
      frozen: 100n,
      total: 100n,
    });

    // The decided record discloses the reading that proves the breach.
    const record = (await records()).find((r) => r.checkpointId === pending.id)!;
    expect(record).toMatchObject({
      decision: 'REJECT',
      outcome: 'FROZEN',
      breach: true,
      kind: 'DOCK_HANDOFF',
    });
    const evidence = fromHex(record.breachReading!);
    const breach = verifyReading({
      payload: toHex(evidence.subarray(0, 144)),
      sig: toHex(evidence.subarray(144)),
    });
    expect(breach.reading).toMatchObject({ tempCenti: 1260, device: device.address });

    // ...and the plan's query finds it: readings for this lot where in_range = false.
    const outOfRange = await fetchReadings(reader, {
      assetId: ASSET,
      device: device.address,
      onlyOutOfRange: true,
    });
    expect(outOfRange.map((r) => r.digest)).toEqual([toHex(breach.digest)]);

    // The episode log keeps the outage on record.
    const { viewKey } = await admin(`/lots/${ASSET}/view-key`);
    const ciphertext = new Uint8Array(
      await (await fetch(`${stack.url}/v1/episodes/${record.episodeRoot}`)).arrayBuffer(),
    );
    const episode = openEpisode(ciphertext, viewKey);
    expect(episode.failedAttempts.length).toBeGreaterThanOrEqual(2);
    expect(episode.policy).toEqual({ stateBefore: 'IN_TRANSIT', breach: true, outcome: 'FROZEN' });
    expect(episode.readings.map((r) => decodeReading(fromHex(r.payload)).tempCenti)).toEqual([
      520, 1260, 610,
    ]);
  }, 120_000);

  it('unfreezes after inspection and completes delivery', async () => {
    await admin(`/lots/${ASSET}/release`, { inspectionRef: `0x${'ee'.repeat(32)}` });
    expect(await chainLot()).toMatchObject({ state: LotState.IN_CUSTODY, breachOpen: false });
    const { token } = await chainLot();
    expect((await stack.gateway.hedera.holding(token, stack.hedera.accounts.depositor.address)).free).toBe(
      100n,
    );

    place('dock', 480);
    await runner.reading();
    expect((await handoff(CheckpointKind.FINAL_DELIVERY)).status).toBe('ACCEPTED');
    expect((await chainLot()).state).toBe(LotState.DELIVERED);
  }, 120_000);

  it('ends with a consistent picture across the three layers', async () => {
    const status = stack.gateway.status();
    expect(status.readings).toMatchObject({ total: 7, published: 7, refused: 0, queued: 0, proofsFailed: 0 });
    expect(status.checkpoints.map((c) => [c.stage, c.outcome])).toEqual([
      ['APPLIED', 'ACCEPTED'],
      ['APPLIED', 'ACCEPTED'],
      ['APPLIED', 'FROZEN'],
      ['APPLIED', 'ACCEPTED'],
    ]);
    expect((await fetchReadings(reader, { assetId: ASSET, device: device.address })).length).toBe(7);
    expect((await records()).map((r) => r.outcome)).toEqual(['ACCEPTED', 'FROZEN', 'ACCEPTED', 'ACCEPTED']);
    // Road readings carry no venue and have no proof; warehouse and dock readings do.
    const proofs = await fetchGeoProofs(reader, { assetId: ASSET, gateway: stack.publicConfig.gateway });
    expect(proofs.map((p) => p.seq)).toEqual([1, 2, 4, 8, 10]);
  });
});
