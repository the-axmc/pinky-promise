/**
 * A device follows one lot at a time, and is free again once that lot is delivered — so the same
 * board can run the demo twice against a gateway that remembers the first run.
 */
import {
  Device,
  DeviceRunner,
  HttpGatewayLink,
  MemoryStorage,
  createSimulatedHardware,
  generateIdentity,
} from '@pinky/device';
import { CheckpointKind } from '@pinky/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalStack, startLocalStack } from '../src/local';

let stack: LocalStack;
let runner: DeviceRunner;
let device: Device;
let stopSigning: () => Promise<void>;

const admin = async (path: string, body: unknown) => {
  const response = await fetch(`${stack.url}/v1/admin${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${stack.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as any;
  return { status: response.status, json };
};
const lotFor = (assetId: string) => ({
  assetId,
  title: assetId,
  device: device.address,
  tempMinCenti: 200,
  tempMaxCenti: 800,
  rhMinCenti: 2000,
  rhMaxCenti: 7000,
  units: 10,
  unitValueCents: 100,
  endsAt: Math.floor(Date.now() / 1000) + 86_400,
  disputeWindowS: 86_400,
});
const handoff = async (kind: (typeof CheckpointKind)[keyof typeof CheckpointKind]) => {
  await runner.reading();
  const sent = await runner.checkpoint(kind);
  const decided = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 60_000 });
  await stack.gateway.idle(60_000, { device: device.address });
  return decided.status;
};

beforeAll(async () => {
  stack = await startLocalStack({ gateway: { retryBaseMs: 300, retryMaxMs: 800 } });
  const hardware = createSimulatedHardware(generateIdentity());
  hardware.climate.set(450, 4500);
  device = await Device.create(hardware, new MemoryStorage(), {
    registry: stack.registry,
    attestor: stack.publicConfig.attestor,
    arkivChainId: stack.arkiv.chainId,
  });
  runner = new DeviceRunner(device, new HttpGatewayLink(stack.url));
  await admin('/venues', {
    venueId: 'WH-1',
    name: 'Warehouse',
    latDeg: 19.076,
    lonDeg: 72.8777,
    radiusM: 150,
  });
  await admin('/devices', { certBundle: await device.certificate(), venueIds: ['WH-1'], label: 'sensor' });
  stopSigning = runner.startSigning(100);
}, 180_000);

afterAll(async () => {
  await stopSigning?.();
  await stack?.stop();
});

describe('one lot at a time', () => {
  it('refuses a second lot while the first is under way, and allows it once delivered', async () => {
    expect((await admin('/lots', lotFor('LOT-A'))).status).toBe(200);
    await runner.sync();
    expect(device.profile?.assetId).toBe('LOT-A');

    const refused = await admin('/lots', lotFor('LOT-B'));
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/still assigned to lot LOT-A/);

    expect(await handoff(CheckpointKind.WAREHOUSE_IN)).toBe('ACCEPTED');
    expect(await handoff(CheckpointKind.FINAL_DELIVERY)).toBe('ACCEPTED');

    expect((await admin('/lots', lotFor('LOT-B'))).status).toBe(200);
    // The device now follows the new lot, and its first handoff there covers only new readings.
    await runner.sync();
    expect(device.profile?.assetId).toBe('LOT-B');
    expect(await handoff(CheckpointKind.WAREHOUSE_IN)).toBe('ACCEPTED');
    const records = Object.values(stack.gateway.store.checkpoints).filter((c) => c.assetId === 'LOT-B');
    expect(records).toHaveLength(1);
  }, 150_000);
});
