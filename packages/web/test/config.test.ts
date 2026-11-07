/** How the page finds the chains: a hosted demo relays them through its own origin. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../src/lib/config';

const answering = (config: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(config))),
  );
const config = (arkiv: string, hedera: string) => ({
  arkiv: { rpcUrl: arkiv, chainId: 1337, registry: '0x00' },
  hedera: { rpcUrl: hedera, chainId: 31337, oracle: '0x00', market: '0x00' },
  zg: { mode: 'mock', model: 'm', storage: 'local' },
  attestor: '0x00',
  gateway: '0x00',
  demo: true,
});

afterEach(() => vi.unstubAllGlobals());

describe('connect', () => {
  it('resolves relayed RPC paths against the page’s gateway', async () => {
    answering(config('/rpc/arkiv', '/rpc/hedera'));
    const ctx = await connect('https://demo.example/');
    expect(ctx.gatewayUrl).toBe('https://demo.example');
    expect(ctx.config.arkiv.rpcUrl).toBe('https://demo.example/rpc/arkiv');
    expect(ctx.hederaChain.rpcUrls.default.http[0]).toBe('https://demo.example/rpc/hedera');
  });

  it('leaves public endpoints alone', async () => {
    answering(config('https://rpc.arkiv.example/', 'https://testnet.hashio.io/api'));
    const ctx = await connect('https://demo.example');
    expect(ctx.config.arkiv.rpcUrl).toBe('https://rpc.arkiv.example/');
    expect(ctx.hederaChain.rpcUrls.default.http[0]).toBe('https://testnet.hashio.io/api');
  });
});
