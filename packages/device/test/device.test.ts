import { beforeEach, describe, expect, it } from 'vitest';
import {
  CheckpointKind,
  Decision,
  type DecisionValue,
  type Hex,
  ProtocolError,
  ZERO_32,
  concat,
  decodeCheckpoint,
  decodeSealEvidence,
  fromHex,
  gpsCommitment,
  noFixOpening,
  requestIdHash,
  secpAddress,
  secpRecover,
  sha256,
  signDecisionAttestation,
  signLotProfile,
  toHex,
  verifyAnchorAttestation,
  verifyCheckpoint,
  verifyDeviceCert,
  verifyReading,
} from '@pinky/protocol';
import {
  ARKIV_ENGINE_ADDRESS,
  Checkpoints,
  type CreateSpec,
  Readings,
  checkpointValues,
  encodeCreates,
  readingValues,
} from '@pinky/protocol/arkiv';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, serializeTransaction } from 'viem';
import {
  Device,
  MemoryStorage,
  SimulatedAnchor,
  type SimulatedHardware,
  createSimulatedHardware,
  generateIdentity,
} from '../src';
import type { CheckpointRequest, ReadingRequest, SignRequest } from '../src';

const registrySecret = fromHex(`0x${'66'.repeat(32)}`);
const attestorSecret = fromHex(`0x${'55'.repeat(32)}`);
const anchorSecret: Hex = `0x${'33'.repeat(32)}`;
const registry = secpAddress(registrySecret);
const attestor = secpAddress(attestorSecret);
const CHAIN_ID = 1337;
const anchorBlock = { blockNumber: 1200, blockHash: `0x${'cd'.repeat(32)}` as Hex };
const NOW = 1_793_966_400;

let hardware: SimulatedHardware;
let anchor: SimulatedAnchor;
let storage: MemoryStorage;
let device: Device;
let clock: { now: () => number };

const config = { registry, attestor, arkivChainId: CHAIN_ID };

function profileFor(address: Hex, overrides: Record<string, unknown> = {}, signer = registrySecret) {
  return signLotProfile(
    {
      assetId: 'LOT-42',
      device: address,
      tempMinCenti: 200,
      tempMaxCenti: 800,
      rhMinCenti: 2000,
      rhMaxCenti: 7000,
      validUntil: NOW + 30 * 86_400,
      ...overrides,
    },
    signer,
  );
}

beforeEach(async () => {
  let t = NOW;
  clock = { now: () => t++ };
  anchor = new SimulatedAnchor(anchorSecret);
  hardware = createSimulatedHardware(generateIdentity(), { anchor, clock });
  hardware.climate.set(425, 4550);
  hardware.position.set({ latDeg: 19.0761, lonDeg: 72.8778 });
  storage = new MemoryStorage();
  device = await Device.create(hardware, storage, config);
  device.setProfile(profileFor(device.address));
});

describe('identity', () => {
  it('issues a certificate chaining the wallet to the secure element, once', async () => {
    const bundle = await device.certificate();
    const verified = verifyDeviceCert(bundle);
    expect(verified.cert.device).toBe(device.address);
    expect(verified.cert.hwPubkey).toBe(toHex(await hardware.secureElement.publicKey()));
    expect(verified.cert.hwSerial).toBe(await hardware.secureElement.serial());
    expect(await device.certificate()).toBe(bundle);
  });

  it('only trusts a lot profile the registry signed for this device', () => {
    const stranger = fromHex(`0x${'77'.repeat(32)}`);
    expect(() => device.setProfile(profileFor(device.address, {}, stranger))).toThrow(/registry/);
    expect(() => device.setProfile(profileFor(`0x${'12'.repeat(20)}`))).toThrow(/another device/);
    expect(() => device.setProfile(profileFor(device.address, { validUntil: NOW - 1 }))).toThrow(/expired/);
    expect(device.profile?.assetId).toBe('LOT-42');
  });
});

describe('reassignment', () => {
  it('starts a new checkpoint window when the device moves to another lot', async () => {
    await device.takeReading(anchorBlock);
    await device.takeReading(anchorBlock);
    device.setProfile(profileFor(device.address, { assetId: 'LOT-43' }));
    // The two readings belong to LOT-42; LOT-43 has none yet.
    await expect(device.takeCheckpoint(CheckpointKind.WAREHOUSE_IN, anchorBlock)).rejects.toThrow(/at least one reading/);
    await device.takeReading(anchorBlock);
    const { checkpoint } = verifyCheckpoint(await device.takeCheckpoint(CheckpointKind.WAREHOUSE_IN, anchorBlock));
    expect(checkpoint).toMatchObject({ assetId: 'LOT-43', firstSeq: 3, lastSeq: 3, readingCount: 1 });
  });

  it('keeps the window when the same lot is confirmed again', async () => {
    await device.takeReading(anchorBlock);
    device.setProfile(profileFor(device.address, { tempMaxCenti: 900 }));
    const { checkpoint } = verifyCheckpoint(await device.takeCheckpoint(CheckpointKind.WAREHOUSE_IN, anchorBlock));
    expect(checkpoint).toMatchObject({ assetId: 'LOT-42', firstSeq: 1, readingCount: 1 });
  });
});

describe('readings', () => {
  it('signs what the sensors report, with a private opening for the position', async () => {
    const request = await device.takeReading(anchorBlock);
    const { reading } = verifyReading(request);
    expect(reading).toMatchObject({
      device: device.address,
      assetId: 'LOT-42',
      tempCenti: 425,
      rhCenti: 4550,
      seq: 1,
      blockhash: anchorBlock.blockHash,
    });
    const opening = request.opening!;
    expect(reading.gpsCommitment).toBe(
      toHex(gpsCommitment({ latUnits: opening.latUnits, lonUnits: opening.lonUnits, salt: fromHex(opening.salt) })),
    );
  });

  it('commits to "no fix" and shares no opening when there is no GPS', async () => {
    hardware.position.set(null);
    const request = await device.takeReading(anchorBlock);
    expect(request.opening).toBeUndefined();
    const { reading } = verifyReading(request);
    // The commitment is to the sentinel with a salt only the device knows.
    expect(reading.gpsCommitment).not.toBe(toHex(gpsCommitment(noFixOpening(new Uint8Array(32)))));
    expect(reading.gpsCommitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('never reuses a sequence number, even across a restart', async () => {
    await device.takeReading(anchorBlock);
    await device.takeReading(anchorBlock);
    const restarted = await Device.create(hardware, storage, config);
    expect(restarted.profile?.assetId).toBe('LOT-42');
    const { reading } = verifyReading(await restarted.takeReading(anchorBlock));
    expect(reading.seq).toBe(3);
  });

  it('refuses to measure before a lot is assigned', async () => {
    const fresh = await Device.create(hardware, new MemoryStorage(), config);
    await expect(fresh.takeReading(anchorBlock)).rejects.toThrow(/no lot assigned/);
  });
});

describe('checkpoints', () => {
  it('bundles the readings since the last checkpoint with the seal evidence', async () => {
    await device.takeReading(anchorBlock);
    await device.takeReading(anchorBlock);
    const first = await device.takeCheckpoint(CheckpointKind.WAREHOUSE_IN, anchorBlock);
    const { checkpoint } = verifyCheckpoint(first);
    expect(checkpoint).toMatchObject({ kind: 1, seq: 3, firstSeq: 1, lastSeq: 2, readingCount: 2 });
    expect(hardware.display.last.state).toBe('PENDING');

    const sealRecord = new Uint8Array(Buffer.from(first.seal, 'base64'));
    expect(checkpoint.sealHash).toBe(toHex(sha256(sealRecord)));
    const evidence = decodeSealEvidence(sealRecord);
    expect(evidence.photo?.sha256).toBe(toHex(sha256(Buffer.from(first.photo!.data, 'base64'))));

    await device.takeReading(anchorBlock);
    const second = decodeCheckpoint(fromHex((await device.takeCheckpoint(CheckpointKind.WAREHOUSE_OUT, anchorBlock)).payload));
    expect(second).toMatchObject({ seq: 5, firstSeq: 4, lastSeq: 4, readingCount: 1 });
  });

  it('needs at least one new reading', async () => {
    await expect(device.takeCheckpoint(CheckpointKind.WAREHOUSE_IN, anchorBlock)).rejects.toThrow(/at least one reading/);
  });

  it('carries the venue anchor co-signature when an anchor is in range', async () => {
    await device.takeReading(anchorBlock);
    const without = await device.takeCheckpoint(CheckpointKind.WAREHOUSE_IN, anchorBlock);
    expect(without.anchor).toBeUndefined();
    expect(decodeCheckpoint(fromHex(without.payload)).anchorDigest).toBe(ZERO_32);

    anchor.setVenue('WH-MUM-01');
    await device.takeReading(anchorBlock);
    const withAnchor = await device.takeCheckpoint(CheckpointKind.WAREHOUSE_OUT, anchorBlock);
    const attestation = verifyAnchorAttestation(withAnchor.anchor!);
    expect(attestation.signer).toBe(anchor.address);
    expect(attestation.attestation).toMatchObject({ venueId: 'WH-MUM-01', device: device.address, blockhash: anchorBlock.blockHash });
    expect(decodeCheckpoint(fromHex(withAnchor.payload)).anchorDigest).toBe(toHex(attestation.digest));
  });

  it('records a broken seal and an open NFC tamper loop', async () => {
    hardware = createSimulatedHardware(generateIdentity(), { clock, nfcUid: '0x04a1b2c3d4e5f6' });
    device = await Device.create(hardware, new MemoryStorage(), config);
    device.setProfile(profileFor(device.address));
    hardware.seal.condition = 'broken';
    await device.takeReading(anchorBlock);
    const request = await device.takeCheckpoint(CheckpointKind.DOCK_HANDOFF, anchorBlock);
    const evidence = decodeSealEvidence(new Uint8Array(Buffer.from(request.seal, 'base64')));
    expect(evidence.nfc).toMatchObject({ uid: '0x04a1b2c3d4e5f6', tamper: 'open' });
  });
});

// ---------------------------------------------------------------------------------------------
// Signing policy
// ---------------------------------------------------------------------------------------------

function txFor(creates: CreateSpec[], overrides: Partial<SignRequest['transaction']> = {}): SignRequest {
  return {
    id: 'req-1',
    purpose: 'reading',
    transaction: {
      chainId: CHAIN_ID,
      nonce: 0,
      gas: '1000000',
      gasPrice: '1000000000',
      to: ARKIV_ENGINE_ADDRESS,
      value: '0',
      data: encodeCreates(creates),
      ...overrides,
    },
  };
}

function readingCreate(request: ReadingRequest, overrides: Record<string, unknown> = {}, spec: Partial<CreateSpec> = {}): CreateSpec {
  const { reading, digest } = verifyReading(request);
  const values = readingValues({
    reading,
    digest: toHex(digest),
    sig: request.sig,
    inRange: true,
    anchorBlock: anchorBlock.blockNumber,
    ...overrides,
  });
  return { schema: Readings, values, salt: 1n, minLifetime: 3600n, readonly: true, ...spec };
}

describe('signing policy: readings', () => {
  let reading: ReadingRequest;

  beforeEach(async () => {
    reading = await device.takeReading(anchorBlock);
  });

  it('signs a transaction that publishes its own reading unchanged', async () => {
    const request = txFor([readingCreate(reading, { venueHash: `0x${'ab'.repeat(32)}` })]);
    const result = await device.sign(request);
    if (!('signature' in result)) throw new Error(`refused: ${result.refused}`);

    // The signature is over the legacy transaction the device serialised from the reviewed fields.
    const unsigned = serializeTransaction({
      type: 'legacy',
      chainId: CHAIN_ID,
      nonce: 0,
      gas: 1_000_000n,
      gasPrice: 1_000_000_000n,
      to: ARKIV_ENGINE_ADDRESS,
      value: 0n,
      data: request.transaction.data,
    });
    const sig = concat(fromHex(result.signature.r), fromHex(result.signature.s), Uint8Array.of(27 + result.signature.yParity));
    expect(secpRecover(fromHex(keccak256(unsigned)), sig).address).toBe(device.address);
  });

  it('signs a batch of several of its readings', async () => {
    const second = await device.takeReading(anchorBlock);
    const result = await device.sign(txFor([readingCreate(reading), readingCreate(second, {}, { salt: 2n })]));
    expect(result).toHaveProperty('signature');
  });

  const refusals: Array<[string, (r: ReadingRequest) => SignRequest, RegExp]> = [
    ['another destination', (r) => txFor([readingCreate(r)], { to: `0x${'99'.repeat(20)}` }), /Arkiv engine/],
    ['another chain', (r) => txFor([readingCreate(r)], { chainId: 1 }), /chain id/],
    ['a value transfer', (r) => txFor([readingCreate(r)], { value: '1' }), /value/],
    ['an excessive fee', (r) => txFor([readingCreate(r)], { gasPrice: '1000000000000000' }), /fee/],
    ['an excessive gas limit', (r) => txFor([readingCreate(r)], { gas: '99000000' }), /gas limit/],
    ['a mutable entity', (r) => txFor([readingCreate(r, {}, { readonly: false })]), /readonly/],
    ['an extendable entity', (r) => txFor([readingCreate(r, {}, { permissionlessExtension: true })]), /readonly/],
    ['an entity without expiry', (r) => txFor([readingCreate(r, {}, { minLifetime: 0n })]), /expiry/],
    ['a flipped in-range flag', (r) => txFor([readingCreate(r, { inRange: false })]), /in_range/],
    ['a different anchor block', (r) => txFor([readingCreate(r, { anchorBlock: 7 })]), /anchor_block/],
    ['a reading it never took', (r) => txFor([readingCreate(r, { digest: `0x${'00'.repeat(32)}` })]), /not produced by this device/],
    ['a malformed venue hash', (r) => txFor([readingCreate(r, { venueHash: '0x1234' })]), /venue_hash/],
  ];
  for (const [name, build, reason] of refusals) {
    it(`refuses ${name}`, async () => {
      const result = await device.sign(build(reading));
      expect(result).toMatchObject({ id: 'req-1', refused: expect.stringMatching(reason) });
    });
  }

  it('refuses an altered signature column and an unknown schema', async () => {
    const forged = readingCreate(reading);
    (forged.values as any).sig = { type: 'bytes', value: `0x${'11'.repeat(65)}` };
    expect(await device.sign(txFor([forged]))).toMatchObject({ refused: expect.stringMatching(/sig/) });

    const other = readingCreate(reading);
    other.schema = { tag: { value: 'someone.else.v1' }, columns: Readings.columns };
    expect(await device.sign(txFor([other]))).toMatchObject({ refused: expect.stringMatching(/unexpected entity type/) });
  });

  it('refuses anything that is not a create: it will never sign away ownership', async () => {
    const transfer = encodeAbiParameters(parseAbiParameters('(bytes32 entityKey, address newOwner)'), [
      { entityKey: `0x${'11'.repeat(32)}`, newOwner: '0x000000000000000000000000000000000000dEaD' },
    ]);
    const data = encodeFunctionData({
      abi: parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)']),
      functionName: 'execute',
      args: [[{ operation: 4, operationData: transfer }]],
    });
    expect(await device.sign(txFor([], { data }))).toMatchObject({ refused: expect.stringMatching(/other than create/) });
    expect(await device.sign(txFor([], { data: '0xdeadbeef' }))).toMatchObject({ refused: expect.stringMatching(/execute/) });
  });
});

describe('signing policy: checkpoints', () => {
  let checkpoint: CheckpointRequest;
  let warm: ReadingRequest;

  /** A Checkpoint entity for the device's checkpoint, as the gateway would build it. */
  function checkpointCreate(
    decision: DecisionValue,
    options: {
      breach?: boolean;
      outcome?: string;
      signer?: Uint8Array;
      requestId?: string;
      attestedRequestId?: string;
      forCheckpoint?: Hex;
      evidence?: ReadingRequest;
      overrides?: Record<string, unknown>;
    } = {},
  ): CreateSpec {
    const verified = verifyCheckpoint(checkpoint);
    const id = toHex(verified.digest);
    const decided = decision !== Decision.PENDING;
    const requestId = options.requestId ?? 'req-0g-1';
    const attestation = {
      checkpointDigest: options.forCheckpoint ?? id,
      decision,
      breach: options.breach ?? false,
      requestIdHash: decided ? requestIdHash(options.attestedRequestId ?? requestId) : ZERO_32,
      episodeRoot: decided ? (`0x${'0f'.repeat(32)}` as Hex) : ZERO_32,
      decidedAt: NOW + 100,
    };
    const signed = signDecisionAttestation(attestation, options.signer ?? attestorSecret);
    const defaultOutcome = { 0: 'PENDING', 1: 'ACCEPTED', 2: options.breach ? 'FROZEN' : 'REFUSED', 3: 'ESCALATED' }[decision];
    const values = checkpointValues({
      checkpoint: verified.checkpoint,
      checkpointId: id,
      payload: checkpoint.payload,
      sig: checkpoint.sig,
      outcome: (options.outcome ?? defaultOutcome) as never,
      reason: 'Seal intact; readings in range.',
      attestation,
      attestationPayload: signed.payload,
      attestor,
      attestorSig: signed.sig,
      zg: decided ? { source: 'dev-mock', requestId, model: 'mock-vision' } : { source: 'none' },
      ...(options.evidence
        ? { breachReading: toHex(concat(fromHex(options.evidence.payload), fromHex(options.evidence.sig))) }
        : {}),
      ...options.overrides,
    });
    return { schema: Checkpoints, values, salt: 9n, minLifetime: 3600n, readonly: true };
  }

  const submit = (create: CreateSpec) => device.sign({ ...txFor([create]), purpose: 'checkpoint' });

  beforeEach(async () => {
    await device.takeReading(anchorBlock);
    checkpoint = await device.takeCheckpoint(CheckpointKind.DOCK_HANDOFF, anchorBlock);
  });

  it('signs a PENDING record, then one decision, and shows the outcome', async () => {
    expect(await submit(checkpointCreate(Decision.PENDING))).toHaveProperty('signature');
    expect(hardware.display.last.state).toBe('PENDING');

    expect(await submit(checkpointCreate(Decision.ACCEPT_CUSTODY))).toHaveProperty('signature');
    expect(hardware.display.last.state).toBe('ACCEPTED');

    // A second decision for the same checkpoint is refused: decisions are final.
    expect(await submit(checkpointCreate(Decision.REJECT))).toMatchObject({
      refused: expect.stringMatching(/already signed/),
    });
  });

  it('refuses a decision that is not from the configured attestor', async () => {
    const stranger = fromHex(`0x${'77'.repeat(32)}`);
    expect(await submit(checkpointCreate(Decision.ACCEPT_CUSTODY, { signer: stranger }))).toMatchObject({
      refused: expect.stringMatching(/signature is invalid/),
    });
  });

  it('refuses a decision made for another checkpoint', async () => {
    const result = await submit(checkpointCreate(Decision.ACCEPT_CUSTODY, { forCheckpoint: `0x${'aa'.repeat(32)}` }));
    expect(result).toMatchObject({ refused: expect.stringMatching(/another checkpoint/) });
  });

  it('refuses columns that disagree with the attestation', async () => {
    expect(await submit(checkpointCreate(Decision.ACCEPT_CUSTODY, { outcome: 'FROZEN' }))).toMatchObject({
      refused: expect.stringMatching(/impossible/),
    });
    expect(await submit(checkpointCreate(Decision.REJECT, { attestedRequestId: 'another-request' }))).toMatchObject({
      refused: expect.stringMatching(/request id/),
    });
  });

  it('refuses a PENDING record that claims a 0G request', async () => {
    const create = checkpointCreate(Decision.PENDING);
    (create.values as any).zg_request_id = { type: 'str', value: 'made-up' };
    expect(await submit(create)).toMatchObject({ refused: expect.stringMatching(/pending record/) });
  });

  it('refuses a breach it did not measure, and evidence that is not a breach', async () => {
    expect(await submit(checkpointCreate(Decision.REJECT, { breach: true }))).toMatchObject({
      refused: expect.stringMatching(/did not measure/),
    });
  });

  describe('when the device did measure a breach', () => {
    beforeEach(async () => {
      hardware.climate.set(1260, 4550);
      warm = await device.takeReading(anchorBlock);
      checkpoint = await device.takeCheckpoint(CheckpointKind.DOCK_HANDOFF, anchorBlock);
    });

    it('signs the freeze with the out-of-range reading attached', async () => {
      const result = await submit(checkpointCreate(Decision.REJECT, { breach: true, evidence: warm }));
      expect(result).toHaveProperty('signature');
      expect(hardware.display.last.state).toBe('FROZEN');
    });

    it('refuses a decision that hides the breach', async () => {
      expect(await submit(checkpointCreate(Decision.ACCEPT_CUSTODY))).toMatchObject({
        refused: expect.stringMatching(/hides an out-of-range reading/),
      });
    });

    it('refuses an attested breach without its evidence', async () => {
      expect(await submit(checkpointCreate(Decision.REJECT, { breach: true }))).toMatchObject({
        refused: expect.stringMatching(/without its evidence/),
      });
    });
  });

  it('refuses a checkpoint it never made', async () => {
    const create = checkpointCreate(Decision.PENDING);
    (create.values as any).checkpoint_id = { type: 'str', value: `0x${'00'.repeat(32)}` };
    expect(await submit(create)).toMatchObject({ refused: expect.stringMatching(/not produced by this device/) });
  });

  it('exposes a typed error for malformed input rather than crashing', () => {
    expect(() => verifyCheckpoint({ payload: '0x00', sig: '0x00' })).toThrow(ProtocolError);
  });
});
