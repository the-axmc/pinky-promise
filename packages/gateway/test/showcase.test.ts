/**
 * The hosted demo's public face: what a visitor can and cannot reach, and a whole journey driven
 * through it. The page's half of this runs in `packages/web/test`.
 */
import { LotState } from '@pinky/protocol';
import { parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DemoStack, localDemoStack } from '../src/demo-stack';
import { JOURNEY_STEPS, Journey } from '../src/journey';
import { type ShowcaseBackend, createShowcaseApp, refuseRpcCall } from '../src/showcase-app';

const BUYER_KEY = `0x${'b1'.repeat(32)}` as const;
const OTHER_KEY = `0x${'c2'.repeat(32)}` as const;
const buyer = privateKeyToAccount(BUYER_KEY);

const rawFrom = (key: `0x${string}`) =>
  privateKeyToAccount(key).signTransaction({
    type: 'eip1559',
    chainId: 31337,
    nonce: 0,
    gas: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    to: buyer.address,
    value: parseEther('1'),
  });

describe('the RPC relay', () => {
  it('passes reads on either chain', async () => {
    expect(await refuseRpcCall('hedera', { method: 'eth_call' }, buyer.address)).toBeUndefined();
    expect(await refuseRpcCall('arkiv', { method: 'arkiv_query' }, buyer.address)).toBeUndefined();
  });

  it('refuses the development chains’ own control methods', async () => {
    for (const method of [
      'anvil_setBalance',
      'evm_mine',
      'hardhat_impersonateAccount',
      'eth_sendTransaction',
    ])
      expect(await refuseRpcCall('hedera', { method }, buyer.address)).toMatch(/not allowed/);
    expect(await refuseRpcCall('hedera', {}, buyer.address)).toMatch(/not allowed/);
  });

  it('lets only the demo buyer send transactions, and only on Hedera', async () => {
    const send = async (key: `0x${string}`) => ({
      method: 'eth_sendRawTransaction',
      params: [await rawFrom(key)],
    });
    expect(await refuseRpcCall('hedera', await send(BUYER_KEY), buyer.address)).toBeUndefined();
    expect(await refuseRpcCall('hedera', await send(OTHER_KEY), buyer.address)).toMatch(
      /only the demo buyer/,
    );
    expect(await refuseRpcCall('hedera', await send(BUYER_KEY), undefined)).toMatch(/only the demo buyer/);
    expect(await refuseRpcCall('arkiv', await send(BUYER_KEY), buyer.address)).toMatch(/not allowed/);
    expect(
      await refuseRpcCall('hedera', { method: 'eth_sendRawTransaction', params: ['0x00'] }, buyer.address),
    ).toMatch(/could not be read/);
  });
});

describe('who may drive', () => {
  const fake = (live: boolean, driveKey?: string): ShowcaseBackend => {
    const journey = {
      next: () => true,
      restart: () => true,
      status: () => ({ step: 0 }),
    } as unknown as Journey;
    return {
      stack: { live, decisions: 'x' } as DemoStack,
      journey,
      ...(driveKey ? { driveKey } : {}),
    };
  };
  const press = (backend: ShowcaseBackend, key?: string) =>
    createShowcaseApp({ backend: () => backend }).request('/v1/showcase/next', {
      method: 'POST',
      ...(key ? { headers: { 'x-drive-key': key } } : {}),
    });

  it('stand-ins are open to anyone by default', async () => {
    expect((await press(fake(false))).status).toBe(202);
  });

  it('live networks are read-only without a configured key: a step costs test funds', async () => {
    expect((await press(fake(true))).status).toBe(403);
    expect((await press(fake(true), 'guess')).status).toBe(403);
  });

  it('a configured key is required, wherever the chains are', async () => {
    for (const live of [true, false]) {
      expect((await press(fake(live, 'the-key'))).status).toBe(401);
      expect((await press(fake(live, 'the-key'), 'wrong')).status).toBe(401);
      expect((await press(fake(live, 'the-key'), 'the-key')).status).toBe(202);
    }
  });

  it('says it is starting until the stack is up', async () => {
    const app = createShowcaseApp({ backend: () => undefined });
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/v1/config')).status).toBe(503);
    expect((await app.request('/v1/showcase/next', { method: 'POST' })).status).toBe(503);
  });

  it('caps onboardings on live networks, where each costs test funds', async () => {
    const stack = { live: true, url: 'http://127.0.0.1:1' } as DemoStack;
    const app = createShowcaseApp({
      backend: () => ({ stack, journey: {} as Journey }),
      onboardingsPerHour: 1,
    });
    const onboard = () => app.request('/v1/demo/onboard', { method: 'POST', body: '{}' });
    expect((await onboard()).status).not.toBe(429); // reaches for the (absent) gateway
    expect((await onboard()).status).toBe(429);
  });
});

describe('a whole journey through the public face', () => {
  let stack: DemoStack;
  let journey: Journey;
  let app: ReturnType<typeof createShowcaseApp>;

  const status = async () => (await (await app.request('/v1/showcase')).json()) as any;
  const state = async () => (await stack.gateway.hedera.lot((await status()).assetId))?.state;

  beforeAll(async () => {
    stack = await localDemoStack({ anyPorts: true });
    journey = new Journey(stack);
    app = createShowcaseApp({ backend: () => ({ stack, journey }) });
    journey.restart();
    await journey.settled();
  }, 180_000);

  afterAll(async () => {
    await journey?.stop();
    await stack?.stop();
  });

  it('exposes no admin or device API', async () => {
    for (const path of ['/v1/admin/status', '/v1/device/context', '/v1/demo/status'])
      expect((await app.request(path)).status).toBe(404);
  });

  it('points the browser at the relay, not at localhost', async () => {
    const config = (await (await app.request('/v1/config')).json()) as any;
    expect(config.arkiv.rpcUrl).toBe('/rpc/arkiv');
    expect(config.hedera.rpcUrl).toBe('/rpc/hedera');
  });

  it('relays reads and refuses a control method', async () => {
    const call = (method: string) =>
      app.request('/rpc/hedera', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      });
    expect(((await (await call('eth_chainId')).json()) as any).result).toBe('0x7a69');
    expect(((await (await call('anvil_mine')).json()) as any).error.message).toMatch(/not allowed/);
  });

  it('does not pile up tokens if "new lot" is pressed before anything happened', async () => {
    const before = (await status()).assetId;
    expect((await app.request('/v1/showcase/restart', { method: 'POST' })).status).toBe(202);
    await journey.settled();
    expect((await status()).assetId).toBe(before);
  });

  it('walks every step to delivery, stopping safely on the way', async () => {
    const expected = [
      LotState.IN_CUSTODY,
      LotState.IN_TRANSIT,
      LotState.IN_TRANSIT,
      LotState.IN_TRANSIT, // the safe stop: the token is not touched
      LotState.FROZEN,
      LotState.IN_CUSTODY,
      LotState.DELIVERED,
    ];
    expect(expected).toHaveLength(JOURNEY_STEPS.length);
    for (const [index, wanted] of expected.entries()) {
      expect((await app.request('/v1/showcase/next', { method: 'POST' })).status).toBe(202);
      // Two visitors pressing at once: the second press does nothing.
      expect((await app.request('/v1/showcase/next', { method: 'POST' })).status).toBe(409);
      await journey.settled();
      const now = await status();
      expect(now.error).toBeNull();
      expect(now.step).toBe(index + 1);
      expect(await state()).toBe(wanted);
    }
    expect((await status()).log.join('\n')).toMatch(/REJECT/);
    expect((await app.request('/v1/showcase/next', { method: 'POST' })).status).toBe(409);
  }, 240_000);

  it('starts over on a new lot', async () => {
    const before = (await status()).assetId;
    expect((await app.request('/v1/showcase/restart', { method: 'POST' })).status).toBe(202);
    await journey.settled();
    const now = await status();
    expect(now.assetId).not.toBe(before);
    expect(now.step).toBe(0);
    expect(await state()).toBe(LotState.REGISTERED);
  }, 120_000);
});
