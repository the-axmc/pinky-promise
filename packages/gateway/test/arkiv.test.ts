import { createWalletClient } from '@arkiv-network/sdk';
import {
  Device,
  MemoryStorage,
  type ReadingRequest,
  type SimulatedHardware,
  createSimulatedHardware,
  generateIdentity,
} from '@pinky/device';
import { type ArkivDevnet, startArkivDevnet } from '@pinky/devnet';
import {
  CheckpointKind,
  Decision,
  type Hex,
  ZERO_32,
  boxAround,
  concat,
  fromHex,
  requestIdHash,
  secpAddress,
  signDecisionAttestation,
  signLotProfile,
  toHex,
  venueHashHex,
  verifyCheckpoint,
  verifyReading,
} from '@pinky/protocol';
import {
  type CheckpointInput,
  ENTITY_FLAGS,
  Lots,
  type ReadingInput,
  fetchCheckpoints,
  fetchDevice,
  fetchGeoProofs,
  fetchLot,
  fetchLots,
  fetchReadings,
  fetchVenues,
  latestPerCheckpoint,
  lotValues,
  shipmentExpiration,
} from '@pinky/protocol/arkiv';
import { http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArkivAdapter } from '../src/arkiv/adapter';
import { DeviceRefusedError, SignRequestQueue } from '../src/arkiv/sign-requests';

const registryKey = generatePrivateKey();
const gatewayKey = generatePrivateKey();
const attestorSecret = fromHex(`0x${'55'.repeat(32)}`);
const attestor = secpAddress(attestorSecret);
const ASSET = 'LOT-42';
const NOW = Math.floor(Date.now() / 1000);
const lifetimes = { endsAt: NOW + 7 * 86_400, disputeWindowS: 14 * 86_400 };
const venue = { venueId: 'WH-MUM-01', name: 'Mumbai cold store', box: boxAround(19.076, 72.8777, 150) };
const token = `0x${'a1'.repeat(20)}` as const;
const oracle = `0x${'b2'.repeat(20)}` as const;

let devnet: ArkivDevnet;
let arkiv: ArkivAdapter;
let queue: SignRequestQueue;
let hardware: SimulatedHardware;
let device: Device;
let pump: NodeJS.Timeout;
/** An out-of-range reading (payload ‖ signature) from the first checkpoint's window. */
let warmEvidence: Hex;

function lotInput(registrySecret: Uint8Array, deviceAddress: Hex) {
  return {
    title: 'Cold-chain pharma pallet #42',
    signedProfile: signLotProfile(
      {
        assetId: ASSET,
        device: deviceAddress,
        tempMinCenti: 200,
        tempMaxCenti: 800,
        rhMinCenti: 2000,
        rhMaxCenti: 7000,
        validUntil: NOW + 30 * 86_400,
      },
      registrySecret,
    ),
    hederaChainId: 296,
    token,
    oracle,
    attestor,
    gateway: arkiv.gateway,
    units: 100,
    ...lifetimes,
  };
}

function readingInput(request: ReadingRequest, anchorBlock: number, overrides: Partial<ReadingInput> = {}): ReadingInput {
  const { reading, digest } = verifyReading(request);
  return { reading, digest: toHex(digest), sig: request.sig, inRange: true, anchorBlock, ...overrides };
}

beforeAll(async () => {
  devnet = await startArkivDevnet({ blockTime: 1 });
  queue = new SignRequestQueue(15_000);
  arkiv = new ArkivAdapter(
    { rpcUrl: devnet.rpcUrl, chainId: devnet.chainId, registryKey, gatewayKey, pollingIntervalMs: 100 },
    queue,
  );
  await devnet.fund(arkiv.registry);
  await devnet.fund(arkiv.gateway);

  hardware = createSimulatedHardware(generateIdentity());
  hardware.climate.set(425, 4550);
  hardware.position.set({ latDeg: 19.0761, lonDeg: 72.8778 });
  device = await Device.create(hardware, new MemoryStorage(), {
    registry: arkiv.registry,
    attestor,
    arkivChainId: devnet.chainId,
  });

  // The device polls for transactions to sign, reviews each one and answers.
  pump = setInterval(async () => {
    for (const request of queue.pendingFor(device.address)) {
      queue.submit(device.address, await device.sign(request));
    }
  }, 50);
}, 60_000);

afterAll(async () => {
  clearInterval(pump);
  await devnet?.stop();
});

describe('Arkiv adapter on the local node, through the unmodified SDK', () => {
  it('writes the registry entities and reads them back scoped by creator', async () => {
    await arkiv.createVenue(venue);
    await arkiv.createDevice({
      certBundle: await device.certificate(),
      venueIds: [venue.venueId],
      label: 'Pocket sensor #1',
      registeredAt: NOW,
    });
    const lot = lotInput(fromHex(registryKey), device.address);
    device.setProfile(lot.signedProfile);
    await arkiv.createLot(lot);

    const venues = await fetchVenues(arkiv.reader, arkiv.registry);
    expect(venues).toHaveLength(1);
    expect(venues[0]).toMatchObject({ venueId: 'WH-MUM-01', venueHash: venueHashHex(venue), box: venue.box, readonly: true });

    const enrolled = await fetchDevice(arkiv.reader, arkiv.registry, device.address);
    expect(enrolled).toMatchObject({ deviceId: device.address, venueIds: ['WH-MUM-01'], creator: arkiv.registry });

    const stored = await fetchLot(arkiv.reader, arkiv.registry, ASSET);
    expect(stored).toMatchObject({
      assetId: ASSET,
      deviceId: device.address,
      token,
      oracle,
      attestor,
      gateway: arkiv.gateway,
      units: 100,
      tempMinCenti: 200,
      tempMaxCenti: 800,
      profileSigner: arkiv.registry,
      creator: arkiv.registry,
    });
  }, 30_000);

  it('does not return a lot that somebody else wrote under the same schema and id', async () => {
    const impostorKey = generatePrivateKey();
    const impostor = privateKeyToAccount(impostorKey);
    await devnet.fund(impostor.address);
    const wallet = createWalletClient({ chain: devnet.chain, transport: http(), account: impostor });
    await wallet.createEntity(
      Lots,
      lotValues({ ...lotInput(fromHex(impostorKey), device.address), title: 'Counterfeit lot' }),
      { expiration: shipmentExpiration(lifetimes), flags: ENTITY_FLAGS.evidence },
    );

    const lots = await fetchLots(arkiv.reader, arkiv.registry);
    expect(lots.map((lot) => lot.title)).toEqual(['Cold-chain pharma pallet #42']);
    expect(await fetchLots(arkiv.reader, impostor.address.toLowerCase() as Hex)).toHaveLength(1);
  }, 30_000);

  it('tops up a device wallet so it can pay for its own entities', async () => {
    expect(await arkiv.balance(device.address)).toBe(0n);
    await arkiv.ensureFunded(device.address, 10n ** 16n, 5n * 10n ** 16n);
    expect(await arkiv.balance(device.address)).toBe(5n * 10n ** 16n);
    expect(await arkiv.ensureFunded(device.address, 10n ** 16n, 5n * 10n ** 16n)).toBeUndefined();
  }, 30_000);

  it('publishes readings the device signs, making the device their creator', async () => {
    const anchor = await arkiv.anchor();
    const first = await device.takeReading(anchor);
    hardware.climate.set(1260, 4550);
    const warm = await device.takeReading(anchor);
    warmEvidence = toHex(concat(fromHex(warm.payload), fromHex(warm.sig)));

    const published = await arkiv.createReadings(
      device.address,
      [
        readingInput(first, anchor.blockNumber, { venueHash: venueHashHex(venue) }),
        readingInput(warm, anchor.blockNumber, { inRange: false }),
      ],
      lifetimes,
    );
    expect(published.entityKeys).toHaveLength(2);

    const readings = await fetchReadings(arkiv.reader, { assetId: ASSET, device: device.address });
    expect(readings.map((r) => [r.seq, r.inRange])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(readings[0]).toMatchObject({
      creator: device.address,
      owner: device.address,
      readonly: true,
      venueHash: venueHashHex(venue),
      digest: toHex(verifyReading(first).digest),
      sig: first.sig,
      anchorBlock: anchor.blockNumber,
      anchorBlockhash: anchor.blockHash,
    });
    expect(await arkiv.blockNumberOf(anchor.blockHash)).toBe(anchor.blockNumber);

    // The question from the plan, as one indexed query.
    const breaches = await fetchReadings(arkiv.reader, { assetId: ASSET, device: device.address, onlyOutOfRange: true });
    expect(breaches.map((r) => r.seq)).toEqual([2]);
    const atVenue = await fetchReadings(arkiv.reader, {
      assetId: ASSET,
      device: device.address,
      venueHash: venueHashHex(venue),
    });
    expect(atVenue.map((r) => r.seq)).toEqual([1]);
  }, 30_000);

  it('cannot publish a reading the device did not measure: the device refuses to sign', async () => {
    const anchor = await arkiv.anchor();
    hardware.climate.set(1300, 4550);
    const warm = await device.takeReading(anchor);
    // The gateway claims the out-of-range reading was fine.
    await expect(
      arkiv.createReadings(device.address, [readingInput(warm, anchor.blockNumber, { inRange: true })], lifetimes),
    ).rejects.toThrow(DeviceRefusedError);
    const readings = await fetchReadings(arkiv.reader, { assetId: ASSET, device: device.address });
    expect(readings.map((r) => r.seq)).toEqual([1, 2]);

    // Told truthfully, it signs.
    await arkiv.createReadings(device.address, [readingInput(warm, anchor.blockNumber, { inRange: false })], lifetimes);
    expect((await fetchReadings(arkiv.reader, { assetId: ASSET, device: device.address })).map((r) => r.seq)).toEqual([1, 2, 3]);
  }, 30_000);

  it('publishes a PENDING checkpoint record and then the decision', async () => {
    const anchor = await arkiv.anchor();
    const request = await device.takeCheckpoint(CheckpointKind.DOCK_HANDOFF, anchor);
    const { checkpoint, digest } = verifyCheckpoint(request);
    const checkpointId = toHex(digest);
    expect([checkpoint.firstSeq, checkpoint.lastSeq]).toEqual([1, 3]);

    const record = (decision: 0 | 2): CheckpointInput => {
      const decided = decision !== Decision.PENDING;
      const attestation = {
        checkpointDigest: checkpointId,
        decision,
        breach: decided,
        requestIdHash: decided ? requestIdHash('mock-req-1') : ZERO_32,
        episodeRoot: decided ? (`0x${'0f'.repeat(32)}` as Hex) : ZERO_32,
        decidedAt: NOW + (decided ? 60 : 30),
      };
      const signed = signDecisionAttestation(attestation, attestorSecret);
      return {
        checkpoint,
        checkpointId,
        payload: request.payload,
        sig: request.sig,
        outcome: decided ? 'FROZEN' : 'PENDING',
        reason: decided ? 'Two readings were above 8 °C.' : '0G has not decided yet.',
        attestation,
        attestationPayload: signed.payload,
        attestor,
        attestorSig: signed.sig,
        zg: decided ? { source: 'dev-mock', requestId: 'mock-req-1', model: 'mock-vision' } : { source: 'none' },
        ...(decided ? { breachReading: warmEvidence } : {}),
      };
    };

    await arkiv.createCheckpoint(device.address, record(Decision.PENDING), lifetimes);
    let records = await fetchCheckpoints(arkiv.reader, { assetId: ASSET, device: device.address });
    expect(records.map((r) => r.decision)).toEqual(['PENDING']);
    expect(records[0]).toMatchObject({ creator: device.address, kind: 'DOCK_HANDOFF', zgSource: 'none', checkpointId });
    expect(records[0]!.zgRequestId).toBeUndefined();

    // The decided record discloses the out-of-range reading that proves the breach.
    await arkiv.createCheckpoint(device.address, record(Decision.REJECT), lifetimes);

    records = await fetchCheckpoints(arkiv.reader, { assetId: ASSET, device: device.address });
    expect(records).toHaveLength(2);
    const [latest] = latestPerCheckpoint(records);
    expect(latest).toMatchObject({
      decision: 'REJECT',
      outcome: 'FROZEN',
      breach: true,
      zgRequestId: 'mock-req-1',
      zgSource: 'dev-mock',
      episodeRoot: `0x${'0f'.repeat(32)}`,
      attestor,
    });
    expect(hardware.display.last.state).toBe('FROZEN');
  }, 30_000);

  it('stores a geofence proof of realistic size under the gateway wallet', async () => {
    const proof = new Uint8Array(8768).fill(7);
    await arkiv.createGeoProof(
      {
        assetId: ASSET,
        deviceId: device.address,
        venueId: venue.venueId,
        venueHash: venueHashHex(venue),
        readingDigest: `0x${'12'.repeat(32)}`,
        seq: 1,
        ts: NOW,
        proofHash: `0x${'34'.repeat(32)}`,
        circuit: 'geofence-v1',
        vkHash: `0x${'56'.repeat(32)}`,
        proof,
      },
      lifetimes,
    );
    const proofs = await fetchGeoProofs(arkiv.reader, { assetId: ASSET, gateway: arkiv.gateway });
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ creator: arkiv.gateway, venueId: 'WH-MUM-01', seq: 1 });
    expect(fromHex(proofs[0]!.proof)).toEqual(proof);
  }, 30_000);
});
