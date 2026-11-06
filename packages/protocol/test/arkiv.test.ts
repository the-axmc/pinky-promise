import { describe, expect, it } from 'vitest';
import { type Hex, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from 'viem';
// Test-only reach into the SDK's internal encoder, to check our decoder against the real thing.
import { encodeCreate } from '../node_modules/@arkiv-network/sdk/src/schema/attributes';
import {
  CheckpointKind,
  Decision,
  buildVectors,
  concat,
  decodeCheckpoint,
  decodeDecisionAttestation,
  decodeReading,
  fromHex,
  toHex,
  venueHashHex,
} from '../src';
import {
  ARKIV_MAX_LIFETIME_S,
  ARKIV_MAX_STRING_BYTES,
  Checkpoints,
  Devices,
  GeoProofs,
  Lots,
  MIN_LIFETIME_S,
  Readings,
  SCHEMA_NAMES,
  Venues,
  checkpointValues,
  decodeExecute,
  deviceValues,
  encodeCreates,
  fitString,
  geoProofValues,
  lifetimeSeconds,
  lotValues,
  plainValue,
  readingValues,
  venueValues,
} from '../src/arkiv';

const vectors = buildVectors();
const venue = {
  venueId: vectors.gps.venueId,
  name: 'Mumbai cold store',
  box: vectors.gps.box,
  anchor: vectors.keys.anchor.address,
};

const EXECUTE_ABI = parseAbi([
  'function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)',
]);
const CREATE_PARAMS = parseAbiParameters(
  '(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)',
);

/** The calldata the SDK would send to create one entity, built with its own attribute encoder. */
function executeCalldata(schema: any, values: any, creationFlags = 1): Hex {
  const attributes = encodeCreate(schema, values);
  const operationData = encodeAbiParameters(CREATE_PARAMS, [
    { salt: 7n, expiresAt: 0n, minLifetime: 3600n, creationFlags, attributes },
  ]);
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [[{ operation: 1, operationData }]],
  });
}

function sampleReadingValues() {
  const vector = vectors.readings[0]!;
  return readingValues({
    reading: decodeReading(fromHex(vector.payload)),
    digest: vector.digest,
    sig: vector.sig,
    inRange: vector.inRange,
    venueHash: vectors.gps.venueHash,
    anchorBlock: 289_691,
  });
}

function sampleCheckpointValues() {
  return checkpointValues({
    checkpoint: decodeCheckpoint(fromHex(vectors.checkpoint.payload)),
    checkpointId: vectors.checkpoint.digest,
    payload: vectors.checkpoint.payload,
    sig: vectors.checkpoint.sig,
    outcome: 'FROZEN',
    reason: 'Seal intact but two readings exceeded 8 °C.',
    attestation: decodeDecisionAttestation(fromHex(vectors.attestation.payload)),
    attestationPayload: vectors.attestation.payload,
    attestor: vectors.keys.attestor.address,
    attestorSig: vectors.attestation.sig,
    zg: {
      source: '0g-router',
      requestId: vectors.attestation.requestId,
      model: 'qwen2.5-vl-72b-instruct',
      provider: '0x000000003f486c7198d6203568a98d02b91f8044',
      teeVerified: true,
    },
    venueHash: vectors.gps.venueHash,
    anchorAttestation: toHex(concat(fromHex(vectors.anchor.payload), fromHex(vectors.anchor.sig))),
    breachReading: toHex(concat(fromHex(vectors.readings[2]!.payload), fromHex(vectors.readings[2]!.sig))),
  });
}

describe('Arkiv schemas', () => {
  it('are tagged with versioned names and stay within the 31-column budget', () => {
    const schemas = { Devices, Venues, Lots, Readings, Checkpoints, GeoProofs };
    for (const schema of Object.values(schemas)) {
      expect(Object.keys((schema as any).columns ?? schema).length).toBeLessThanOrEqual(31);
    }
    expect(Object.values(SCHEMA_NAMES)).toEqual([
      'pinky.device.v1',
      'pinky.venue.v1',
      'pinky.lot.v1',
      'pinky.reading.v1',
      'pinky.checkpoint.v1',
      'pinky.geoproof.v1',
    ]);
  });

  it('accept the values built for every entity (the SDK validates types and sizes)', () => {
    const profile = { payload: vectors.lotProfile.payload, sig: vectors.lotProfile.sig };
    const cases: Array<[any, any]> = [
      [
        Devices,
        deviceValues({
          certBundle: vectors.cert.bundle,
          venueIds: ['WH-MUM-01', 'DK-PNQ-02'],
          label: 'Pocket sensor #1',
          registeredAt: 1_793_900_000,
        }),
      ],
      [Venues, venueValues(venue)],
      [Venues, venueValues({ ...venue, anchor: undefined })],
      [
        Lots,
        lotValues({
          title: 'Cold-chain pharma pallet #42',
          signedProfile: profile,
          hederaChainId: 296,
          token: '0x068587e2ceeda1fb1f9b51d4e3a7257d8ebadba8',
          oracle: '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f',
          attestor: vectors.keys.attestor.address,
          gateway: vectors.keys.registry.address,
          units: 100,
          endsAt: 1_794_500_000,
          disputeWindowS: 14 * 86_400,
        }),
      ],
      [Readings, sampleReadingValues()],
      [Checkpoints, sampleCheckpointValues()],
      [
        GeoProofs,
        geoProofValues({
          assetId: 'LOT-42',
          deviceId: vectors.keys.device.address,
          venueId: venue.venueId,
          venueHash: venueHashHex(venue),
          readingDigest: vectors.readings[0]!.digest,
          seq: 5,
          ts: 1_793_966_550,
          proofHash: `0x${'ab'.repeat(32)}`,
          circuit: 'geofence-v1',
          vkHash: `0x${'cd'.repeat(32)}`,
          proof: new Uint8Array(8768),
        }),
      ],
    ];
    for (const [schema, values] of cases) {
      const attributes = encodeCreate(schema, values);
      expect(attributes.length).toBeGreaterThan(0);
      expect(attributes.length).toBeLessThanOrEqual(32);
    }
  });

  it('cut long text to fit a string attribute without splitting characters', () => {
    const long = 'é'.repeat(200);
    const fitted = fitString(long);
    expect(new TextEncoder().encode(fitted).length).toBeLessThanOrEqual(ARKIV_MAX_STRING_BYTES);
    expect(fitted.endsWith('…')).toBe(true);
    expect(fitString('short')).toBe('short');
  });
});

describe('execute calldata decoder', () => {
  it('reads back exactly what the SDK encoder wrote for a reading', () => {
    const values = sampleReadingValues();
    const decoded = decodeExecute(executeCalldata(Readings, values));
    expect(decoded.operations).toEqual([1]);
    const [create] = decoded.creates;
    expect(create!.readonly).toBe(true);
    expect(create!.permissionlessExtension).toBe(false);
    expect(create!.salt).toBe(7n);
    expect(create!.minLifetime).toBe(3600n);

    expect(create!.attributes.get('arkiv.schema')).toEqual({
      type: 'str',
      indexed: true,
      value: 'pinky.reading.v1',
    });
    for (const [name, value] of Object.entries(values)) {
      expect(create!.attributes.get(name)?.value, name).toBe(plainValue(value as any));
    }
    expect(create!.attributes.size).toBe(Object.keys(values).length + 1);
    expect(create!.attributes.get('seq')).toEqual({ type: 'u64', indexed: true, value: 5n });
    expect(create!.attributes.get('in_range')).toEqual({ type: 'bool', indexed: true, value: true });
    expect(create!.attributes.get('sig')?.indexed).toBe(false);
  });

  it('reads back a checkpoint, including optional and byte columns', () => {
    const values = sampleCheckpointValues();
    const [create] = decodeExecute(executeCalldata(Checkpoints, values)).creates;
    for (const [name, value] of Object.entries(values)) {
      expect(create!.attributes.get(name)?.value, name).toBe(plainValue(value as any));
    }
    expect(create!.attributes.get('kind')?.value).toBe('DOCK_HANDOFF');
    expect(create!.attributes.get('decision')?.value).toBe('REJECT');
    expect(create!.attributes.get('zg_tee_verified')?.value).toBe(true);
    expect(CheckpointKind.DOCK_HANDOFF).toBe(3);
    expect(Decision.REJECT).toBe(2);
  });

  it('reads signed integers back with their sign', () => {
    const profile = { payload: vectors.lotProfile.payload, sig: vectors.lotProfile.sig };
    const values = lotValues({
      title: 'Frozen lot',
      signedProfile: profile,
      hederaChainId: 296,
      token: '0x068587e2ceeda1fb1f9b51d4e3a7257d8ebadba8',
      oracle: '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f',
      attestor: vectors.keys.attestor.address,
      gateway: vectors.keys.registry.address,
      units: 100,
      endsAt: 1_794_500_000,
      disputeWindowS: 3600,
    });
    const [create] = decodeExecute(executeCalldata(Lots, values, 3)).creates;
    expect(create!.attributes.get('temp_min_c')).toEqual({ type: 'i32', indexed: false, value: 200 });
    expect(create!.permissionlessExtension).toBe(true);
  });

  it('has a reference encoder that matches the SDK byte for byte', () => {
    const cases: Array<[any, any, number]> = [
      [Readings, sampleReadingValues(), 1],
      [Checkpoints, sampleCheckpointValues(), 1],
      [Venues, venueValues(venue), 3],
      [
        Devices,
        deviceValues({
          certBundle: vectors.cert.bundle,
          venueIds: ['WH-MUM-01'],
          label: 'Sensor',
          registeredAt: 5,
        }),
        3,
      ],
    ];
    for (const [schema, values, flags] of cases) {
      const ours = encodeCreates([
        {
          schema,
          values,
          salt: 7n,
          minLifetime: 3600n,
          readonly: (flags & 1) !== 0,
          permissionlessExtension: (flags & 2) !== 0,
        },
      ]);
      expect(ours).toBe(executeCalldata(schema, values, flags));
    }
  });

  it('reports non-create operations so a signer can refuse them', () => {
    const transfer = encodeAbiParameters(parseAbiParameters('(bytes32 entityKey, address newOwner)'), [
      { entityKey: `0x${'11'.repeat(32)}`, newOwner: '0x000000000000000000000000000000000000dEaD' },
    ]);
    const data = encodeFunctionData({
      abi: EXECUTE_ABI,
      functionName: 'execute',
      args: [[{ operation: 4, operationData: transfer }]],
    });
    expect(decodeExecute(data)).toEqual({ operations: [4], creates: [] });
  });

  it('rejects data that is not an execute() call', () => {
    expect(() => decodeExecute('0xdeadbeef')).toThrow(/execute/);
  });
});

describe('lifetimes', () => {
  it('clamp to the chain bounds and land on whole blocks', () => {
    expect(lifetimeSeconds(1)).toBe(MIN_LIFETIME_S);
    expect(lifetimeSeconds(3601)).toBe(3602);
    expect(lifetimeSeconds(10 * 365 * 86_400)).toBe(ARKIV_MAX_LIFETIME_S);
    expect(lifetimeSeconds(-50)).toBe(MIN_LIFETIME_S);
  });
});
