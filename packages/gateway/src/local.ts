/**
 * The whole system on one machine, with no accounts, keys or tokens to obtain.
 *
 *   Hedera  → anvil loaded with the real Asset Tokenization Studio contracts
 *   Arkiv   → the local Arkiv-compatible node (unmodified SDK on top)
 *   0G      → the stand-in Router and a directory for episode logs
 *   gateway → this package, wired to the three of them and served over HTTP
 *
 * Switching to the testnets is configuration only (see config.ts): the gateway code is the same.
 * Decisions made here are recorded as "dev-mock", never as 0G decisions.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import {
  type ArkivDevnet,
  type HederaDevnet,
  MOCK_MODEL,
  type MockZgRouter,
  freePort,
  startArkivDevnet,
  startHederaDevnet,
  startMockZgRouter,
} from '@pinky/devnet';
import type { Address, Hex } from '@pinky/protocol';
import { mnemonicToAccount } from 'viem/accounts';
import { ArkivAdapter } from './arkiv/adapter';
import { SignRequestQueue } from './arkiv/sign-requests';
import { Gateway, type GatewayOptions } from './gateway';
import { HederaAdapter } from './hedera/adapter';
import { type PublicConfig, createApp } from './http';
import { GatewayStore } from './store';
import { ZgDecisionClient } from './zg/decision';
import { LocalEpisodeStore } from './zg/storage';

/** anvil's public development mnemonic. Keys derived from it are for local use only. */
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
export const devKey = (index: number): Hex => {
  const key = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index }).getHdKey().privateKey!;
  return `0x${Buffer.from(key).toString('hex')}`;
};

export type LocalStackOptions = {
  /** Port of the gateway's HTTP API. Default: a free port. */
  port?: number;
  /** Where the gateway keeps its state and the local episode store. Default: memory + temp. */
  dataDir?: string;
  /** Seconds between Arkiv blocks (2 on the real chain). */
  arkivBlockTime?: number;
  /** Fixed ports for the three networks, so a browser can be pointed at them. */
  ports?: { arkiv?: number; arkivAnvil?: number; hedera?: number; zg?: number };
  /**
   * Ask the real 0G Compute Router for decisions while the chains stay local. Without it the
   * stand-in model is used, which cannot see: it recognises only the simulator's two pictures.
   */
  zg?: { baseUrl: string; apiKey: string; model: string; verifyTee?: boolean };
  gateway?: Partial<GatewayOptions>;
  log?: GatewayOptions['log'];
};

export type LocalStack = {
  /** Base URL of the gateway API. */
  url: string;
  adminToken: string;
  gateway: Gateway;
  arkiv: ArkivDevnet;
  hedera: HederaDevnet;
  zg: MockZgRouter;
  publicConfig: PublicConfig;
  registry: Address;
  stop(): Promise<void>;
};

export async function startLocalStack(options: LocalStackOptions = {}): Promise<LocalStack> {
  const [arkivNet, hederaNet, zg] = await Promise.all([
    startArkivDevnet({
      blockTime: options.arkivBlockTime ?? 1,
      ...(options.ports?.arkiv ? { port: options.ports.arkiv } : {}),
      ...(options.ports?.arkivAnvil ? { anvilPort: options.ports.arkivAnvil } : {}),
    }),
    startHederaDevnet(options.ports?.hedera ? { port: options.ports.hedera } : {}),
    startMockZgRouter(options.ports?.zg ? { port: options.ports.zg } : {}),
  ]);
  let server: ServerType | undefined;
  try {
    const registryKey = devKey(6);
    const gatewayKey = devKey(7);
    const attestorKey = devKey(8);

    const signRequests = new SignRequestQueue(30_000);
    const arkiv = new ArkivAdapter(
      {
        rpcUrl: arkivNet.rpcUrl,
        chainId: arkivNet.chainId,
        registryKey,
        gatewayKey,
        pollingIntervalMs: 100,
        txTimeoutMs: 60_000,
      },
      signRequests,
    );
    await arkivNet.fund(arkiv.registry);
    await arkivNet.fund(arkiv.gateway);

    const hedera = new HederaAdapter({
      rpcUrl: hederaNet.rpcUrl,
      chainId: hederaNet.chainId,
      factory: hederaNet.factory,
      resolver: hederaNet.resolver,
      oracle: hederaNet.oracle,
      market: hederaNet.market,
      issuerKey: hederaNet.accounts.issuer.privateKey,
      relayerKey: hederaNet.accounts.relayer.privateKey,
      inspectorKey: hederaNet.accounts.inspector.privateKey,
      pollingIntervalMs: 50,
    });

    const zgClient = options.zg
      ? new ZgDecisionClient({ mode: 'router', ...options.zg })
      : new ZgDecisionClient({ mode: 'mock', baseUrl: zg.baseUrl, apiKey: 'local-dev', model: MOCK_MODEL });
    const episodeDir = options.dataDir
      ? join(options.dataDir, 'zg-storage')
      : join(process.cwd(), '.data', `zg-storage-${process.pid}`);
    if (options.dataDir) mkdirSync(options.dataDir, { recursive: true });
    const store = new GatewayStore(options.dataDir ? join(options.dataDir, 'gateway.json') : undefined);

    const gateway = new Gateway(
      arkiv,
      hedera,
      zgClient,
      new LocalEpisodeStore(episodeDir),
      signRequests,
      store,
      {
        attestorKey,
        registryKey,
        retryBaseMs: 500,
        retryMaxMs: 3_000,
        ...(options.log ? { log: options.log } : {}),
        ...options.gateway,
      },
    );

    const publicConfig: PublicConfig = {
      arkiv: { rpcUrl: arkivNet.rpcUrl, chainId: arkivNet.chainId, registry: arkiv.registry },
      hedera: {
        rpcUrl: hederaNet.rpcUrl,
        chainId: hederaNet.chainId,
        oracle: hederaNet.oracle,
        market: hederaNet.market,
      },
      zg: options.zg
        ? { mode: 'router', model: options.zg.model, storage: 'local' }
        : { mode: 'mock', model: MOCK_MODEL, storage: 'local' },
      attestor: gateway.attestor,
      gateway: arkiv.gateway,
      demo: true,
    };
    const adminToken = 'local-admin-token';
    const app = createApp(gateway, { publicConfig, adminToken });
    const port = options.port ?? (await freePort());
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
    gateway.start(200);

    return {
      url: `http://127.0.0.1:${port}`,
      adminToken,
      gateway,
      arkiv: arkivNet,
      hedera: hederaNet,
      zg,
      publicConfig,
      registry: arkiv.registry,
      async stop() {
        await gateway.stop();
        await new Promise<void>((done) => server!.close(() => done()));
        await Promise.all([arkivNet.stop(), hederaNet.stop(), zg.stop()]);
      },
    };
  } catch (error) {
    server?.close();
    await Promise.allSettled([arkivNet.stop(), hederaNet.stop(), zg.stop()]);
    throw error;
  }
}
