/**
 * What the demo runs on: either the local stack (no keys, nothing to fund) or the networks named
 * in `.env` (`pnpm demo --live`). Both give the journey the same handles, so the acts are the
 * same code either way — only where the transactions land differs.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { type ServerType, serve } from '@hono/node-server';
import { hederaDevChain } from '@pinky/devnet';
import type { Address, Hex } from '@pinky/protocol';
import type { Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assembleGateway } from './assemble';
import { loadEnvFile, readConfig } from './config';
import type { Gateway, GatewayOptions } from './gateway';
import { createApp } from './http';
import { startLocalStack } from './local';

export type DemoStack = {
  /** True when the transactions go to the networks in `.env` rather than the local stand-ins. */
  live: boolean;
  url: string;
  adminToken: string;
  registry: Address;
  attestor: Address;
  arkiv: { rpcUrl: string; chainId: number };
  hedera: {
    rpcUrl: string;
    chainId: number;
    oracle: Address;
    market: Address;
    chain: Chain;
    /** Receives the units when custody is first accepted, and offers some on the market. */
    depositor: { address: Address; privateKey: Hex };
    /** A wallet to allow-list up front, when one is known. */
    buyer?: Address;
  };
  gateway: Gateway;
  /** One line for the banner: who decides. */
  decisions: string;
  /** Decisions come from the real 0G Compute Router. */
  realModel: boolean;
  /** Cuts or restores the gateway's route to 0G, to rehearse the safe stop. */
  setOutage(down: boolean): void;
  /** Where the settings came from, in live mode. */
  envFile?: string;
  stop(): Promise<void>;
};

const PORTS = { gateway: 8787, arkiv: 8645, arkivAnvil: 8646, hedera: 8745, zg: 8845 };
const isLocal = (url: string) => /\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

/** The local stack on fixed ports, optionally asking the real 0G Router for decisions. */
export async function localDemoStack(options: { log?: GatewayOptions['log'] }): Promise<DemoStack> {
  const zg =
    process.env.ZG_ROUTER_URL && process.env.ZG_API_KEY && process.env.ZG_MODEL
      ? { baseUrl: process.env.ZG_ROUTER_URL, apiKey: process.env.ZG_API_KEY, model: process.env.ZG_MODEL }
      : undefined;
  const stack = await startLocalStack({
    port: PORTS.gateway,
    ports: { arkiv: PORTS.arkiv, arkivAnvil: PORTS.arkivAnvil, hedera: PORTS.hedera, zg: PORTS.zg },
    ...(zg ? { zg } : {}),
    gateway: { retryBaseMs: 500, retryMaxMs: 2_000 },
    ...(options.log ? { log: options.log } : {}),
  });
  return {
    live: false,
    url: stack.url,
    adminToken: stack.adminToken,
    registry: stack.registry,
    attestor: stack.publicConfig.attestor,
    arkiv: { rpcUrl: stack.arkiv.rpcUrl, chainId: stack.arkiv.chainId },
    hedera: {
      rpcUrl: stack.hedera.rpcUrl,
      chainId: stack.hedera.chainId,
      oracle: stack.hedera.oracle,
      market: stack.hedera.market,
      chain: hederaDevChain(stack.hedera.rpcUrl, stack.hedera.chainId),
      depositor: stack.hedera.accounts.depositor,
      buyer: stack.hedera.accounts.buyer.address,
    },
    gateway: stack.gateway,
    decisions: zg
      ? `0G Compute Router, model ${zg.model} (chains are local)`
      : 'stand-in model (recorded as "dev-mock", never as 0G)',
    realModel: Boolean(zg),
    setOutage(down) {
      if (zg) throw new Error('the outage rehearsal needs the stand-in model when the chains are local');
      stack.zg.setMode(down ? 'down' : 'up');
    },
    stop: () => stack.stop(),
  };
}

/** The gateway assembled from `.env`, in this process, against whatever networks it names. */
export async function liveDemoStack(options: { log?: GatewayOptions['log'] }): Promise<DemoStack> {
  const envFile = loadEnvFile();
  const config = readConfig();
  mkdirSync(config.dataDir, { recursive: true });

  // The one route the demo may cut: calls to 0G fail as if the network were down.
  let routeCut = false;
  const zgFetch: typeof fetch = (input, init) =>
    routeCut
      ? Promise.reject(new TypeError('fetch failed (the demo cut the route to 0G)'))
      : fetch(input, init);

  const local = isLocal(config.hedera.rpcUrl) && isLocal(config.arkiv.rpcUrl ?? '');
  const { gateway, arkiv, hedera, publicConfig } = assembleGateway(config, {
    zgFetch,
    ...(options.log ? { log: options.log } : {}),
    ...(local ? { pollingIntervalMs: 150, gateway: { retryBaseMs: 500, retryMaxMs: 2_000 } } : {}),
  });

  const adminToken = config.adminToken ?? randomBytes(24).toString('hex');
  const app = createApp(gateway, { publicConfig, adminToken });
  const server: ServerType = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  gateway.start(local ? 200 : 1_000);

  const depositorKey = config.demoAccounts.depositorKey ?? config.hedera.issuerKey;
  return {
    live: true,
    url: `http://${config.host}:${config.port}`,
    adminToken,
    registry: arkiv.registry,
    attestor: publicConfig.attestor,
    arkiv: { rpcUrl: publicConfig.arkiv.rpcUrl, chainId: publicConfig.arkiv.chainId },
    hedera: {
      rpcUrl: config.hedera.rpcUrl,
      chainId: config.hedera.chainId,
      oracle: config.hedera.oracle,
      market: config.hedera.market,
      chain: hedera.chain,
      depositor: {
        address: privateKeyToAccount(depositorKey).address.toLowerCase() as Address,
        privateKey: depositorKey,
      },
      ...(config.demoAccounts.buyerAddress ? { buyer: config.demoAccounts.buyerAddress } : {}),
    },
    gateway,
    decisions:
      config.zg.mode === 'router'
        ? `0G Compute Router, model ${config.zg.model}`
        : 'STAND-IN model (ZG_MODE=mock): recorded as "dev-mock", never as 0G',
    realModel: config.zg.mode === 'router',
    setOutage(down) {
      routeCut = down;
    },
    ...(envFile ? { envFile } : {}),
    async stop() {
      await gateway.stop();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
