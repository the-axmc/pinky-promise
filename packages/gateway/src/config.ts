/**
 * The gateway's configuration for real networks, read from the environment (and from a `.env`
 * file at the repository root, if there is one). `.env.example` documents every variable.
 *
 * The local stack (local.ts) does not use this: it needs no keys or accounts.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from '@pinky/protocol';
import { ATS_HEDERA_TESTNET } from '@pinky/protocol/hedera';
import { z } from 'zod';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const key = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a private key: 0x followed by 64 hex characters');
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be an address: 0x followed by 40 hex characters');
const flag = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  DATA_DIR: z.string().default('.data/gateway'),
  ADMIN_TOKEN: z.string().min(16, 'use at least 16 characters').optional(),
  GATEWAY_DEMO: flag,
  GEOFENCE_PROOFS: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((value) => value === 'true' || value === '1'),

  REGISTRY_KEY: key,
  GATEWAY_KEY: key,
  ATTESTOR_KEY: key,

  ARKIV_RPC_URL: z.string().url().optional(),
  ARKIV_CHAIN_ID: z.coerce.number().int().optional(),
  ARKIV_ACCESS_KEY: z.string().optional(),
  ARKIV_PUBLIC_RPC_URL: z.string().url().optional(),
  ARKIV_EXPLORER_URL: z.string().url().optional(),

  HEDERA_RPC_URL: z.string().url().default('https://testnet.hashio.io/api'),
  HEDERA_CHAIN_ID: z.coerce.number().int().default(ATS_HEDERA_TESTNET.chainId),
  HEDERA_ATS_FACTORY: address.default(ATS_HEDERA_TESTNET.factory),
  HEDERA_ATS_RESOLVER: address.default(ATS_HEDERA_TESTNET.resolver),
  HEDERA_ORACLE: address,
  HEDERA_MARKET: address,
  HEDERA_ISSUER_KEY: key,
  HEDERA_RELAYER_KEY: key,
  HEDERA_INSPECTOR_KEY: key,
  HEDERA_EXPLORER_URL: z.string().url().default('https://hashscan.io/testnet'),

  ZG_ROUTER_URL: z.string().url().default('https://router-api.0g.ai/v1'),
  ZG_API_KEY: z.string().min(1, 'is required: decisions are never made without 0G'),
  ZG_MODEL: z.string().min(1, 'name a model that accepts images (see `pnpm doctor`)'),
  ZG_VERIFY_TEE: flag,
  ZG_STORAGE_RPC_URL: z.string().url().default('https://evmrpc-testnet.0g.ai'),
  ZG_STORAGE_INDEXER_URL: z.string().url().default('https://indexer-storage-testnet-turbo.0g.ai'),
  ZG_STORAGE_KEY: key,
  ZG_STORAGE_EXPLORER_URL: z.string().url().optional(),
});

const UNUSED_KEY = `0x${'00'.repeat(31)}01`;
const UNUSED_ADDRESS = `0x${'00'.repeat(20)}`;
/** Stand-ins for required values a partial command does not use. Never sent anywhere. */
const PLACEHOLDERS: Record<string, string> = {
  REGISTRY_KEY: UNUSED_KEY,
  GATEWAY_KEY: UNUSED_KEY,
  ATTESTOR_KEY: UNUSED_KEY,
  HEDERA_ORACLE: UNUSED_ADDRESS,
  HEDERA_MARKET: UNUSED_ADDRESS,
  HEDERA_ISSUER_KEY: UNUSED_KEY,
  HEDERA_RELAYER_KEY: UNUSED_KEY,
  HEDERA_INSPECTOR_KEY: UNUSED_KEY,
  ZG_API_KEY: 'unused',
  ZG_MODEL: 'unused',
  ZG_STORAGE_KEY: UNUSED_KEY,
};

export type GatewayConfig = {
  port: number;
  host: string;
  dataDir: string;
  adminToken?: string;
  demo: boolean;
  geofenceProofs: boolean;
  keys: { registry: Hex; gateway: Hex; attestor: Hex };
  arkiv: {
    rpcUrl?: string;
    chainId?: number;
    accessKey?: string;
    publicRpcUrl?: string;
    explorerUrl?: string;
  };
  hedera: {
    rpcUrl: string;
    chainId: number;
    factory: Address;
    resolver: Address;
    oracle: Address;
    market: Address;
    issuerKey: Hex;
    relayerKey: Hex;
    inspectorKey: Hex;
    explorerUrl: string;
  };
  zg: {
    routerUrl: string;
    apiKey: string;
    model: string;
    verifyTee: boolean;
    storage: { rpcUrl: string; indexerUrl: string; privateKey: Hex; explorerUrl?: string };
  };
};

/** Loads `.env` from where the command was run, or from the repository root. Existing variables win. */
export function loadEnvFile(): string | undefined {
  for (const candidate of [
    resolve(process.env.INIT_CWD ?? process.cwd(), '.env'),
    resolve(REPO_ROOT, '.env'),
  ]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
  }
  return undefined;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`configuration is incomplete:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Reads the configuration. `only` limits which variables must be present, for commands that
 * need just a part of it (deploying to Hedera does not need 0G keys).
 */
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  only?: ReadonlyArray<keyof z.input<typeof Env>>,
): GatewayConfig {
  // An empty value in .env means "not set".
  const present: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  if (only) {
    // A command that needs only part of the configuration gets placeholders for the rest.
    for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) {
      if (!only.includes(name as never) && present[name] === undefined) present[name] = placeholder;
    }
  }
  const parsed = Env.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map(
        (issue) =>
          `${issue.path.join('.')} ${issue.message.replace(/^Invalid input: expected \w+, received undefined$/, 'is not set')}`,
      ),
    );
  }
  const e = parsed.data as z.output<typeof Env>;
  const fromRoot = (path: string) => resolve(REPO_ROOT, path);
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: fromRoot(e.DATA_DIR),
    ...(e.ADMIN_TOKEN ? { adminToken: e.ADMIN_TOKEN } : {}),
    demo: e.GATEWAY_DEMO,
    geofenceProofs: e.GEOFENCE_PROOFS,
    keys: { registry: e.REGISTRY_KEY as Hex, gateway: e.GATEWAY_KEY as Hex, attestor: e.ATTESTOR_KEY as Hex },
    arkiv: {
      ...(e.ARKIV_RPC_URL ? { rpcUrl: e.ARKIV_RPC_URL } : {}),
      ...(e.ARKIV_CHAIN_ID ? { chainId: e.ARKIV_CHAIN_ID } : {}),
      ...(e.ARKIV_ACCESS_KEY ? { accessKey: e.ARKIV_ACCESS_KEY } : {}),
      ...(e.ARKIV_PUBLIC_RPC_URL ? { publicRpcUrl: e.ARKIV_PUBLIC_RPC_URL } : {}),
      ...(e.ARKIV_EXPLORER_URL ? { explorerUrl: e.ARKIV_EXPLORER_URL } : {}),
    },
    hedera: {
      rpcUrl: e.HEDERA_RPC_URL,
      chainId: e.HEDERA_CHAIN_ID,
      factory: e.HEDERA_ATS_FACTORY as Address,
      resolver: e.HEDERA_ATS_RESOLVER as Address,
      oracle: e.HEDERA_ORACLE as Address,
      market: e.HEDERA_MARKET as Address,
      issuerKey: e.HEDERA_ISSUER_KEY as Hex,
      relayerKey: e.HEDERA_RELAYER_KEY as Hex,
      inspectorKey: e.HEDERA_INSPECTOR_KEY as Hex,
      explorerUrl: e.HEDERA_EXPLORER_URL,
    },
    zg: {
      routerUrl: e.ZG_ROUTER_URL,
      apiKey: e.ZG_API_KEY,
      model: e.ZG_MODEL,
      verifyTee: e.ZG_VERIFY_TEE,
      storage: {
        rpcUrl: e.ZG_STORAGE_RPC_URL,
        indexerUrl: e.ZG_STORAGE_INDEXER_URL,
        privateKey: e.ZG_STORAGE_KEY as Hex,
        ...(e.ZG_STORAGE_EXPLORER_URL ? { explorerUrl: e.ZG_STORAGE_EXPLORER_URL } : {}),
      },
    },
  };
}
