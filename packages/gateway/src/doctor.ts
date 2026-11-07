/**
 * `pnpm doctor` — checks, before anything is sent, that the configured networks answer, the
 * accounts exist and have funds, the contracts are where the configuration says, and 0G has a
 * model that can look at a photo. It reads only; it never sends a transaction.
 */
import { rabdi } from '@arkiv-network/sdk/chains';
import { ATS_HEDERA_TESTNET } from '@pinky/protocol/hedera';
import { createPublicClient, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadEnvFile } from './config';

type Hex = `0x${string}`;
let failures = 0;
const ok = (line: string) => console.log(`  ✔ ${line}`);
const warn = (line: string) => console.log(`  ! ${line}`);
const bad = (line: string) => {
  failures += 1;
  console.log(`  ✖ ${line}`);
};
const env = (name: string) => process.env[name] || undefined;
const account = (name: string) => {
  const value = env(name);
  if (!value) return void bad(`${name} is not set`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return void bad(`${name} is not a private key (0x + 64 hex)`);
  return privateKeyToAccount(value as Hex);
};
const reason = (error: unknown) => (error as Error).message.split('\n')[0];

async function chain(
  label: string,
  url: string,
  expected: number | undefined,
  who: Array<[string, ReturnType<typeof account>]>,
  unit: string,
) {
  const client = createPublicClient({ transport: http(url, { timeout: 15_000 }) });
  try {
    const id = await client.getChainId();
    if (expected !== undefined && id !== expected) bad(`${label}: chain id is ${id}, expected ${expected}`);
    else ok(`${label} answers (chain ${id})`);
  } catch (error) {
    bad(`${label} is unreachable: ${reason(error)}`);
    return undefined;
  }
  for (const [role, signer] of who) {
    if (!signer) continue;
    const balance = await client.getBalance({ address: signer.address }).catch(() => undefined);
    if (balance === undefined) bad(`${role} ${signer.address}: balance could not be read`);
    else if (balance === 0n) bad(`${role} ${signer.address} has no ${unit}`);
    else ok(`${role} ${signer.address}: ${formatEther(balance)} ${unit}`);
  }
  return client;
}

async function main(): Promise<void> {
  const file = loadEnvFile();
  console.log(file ? `configuration: ${file}\n` : 'no .env file found: using the environment only\n');

  console.log('Arkiv');
  const arkivUrl =
    env('ARKIV_RPC_URL') ?? rabdi({ accessKey: env('ARKIV_ACCESS_KEY') ?? '' }).rpcUrls.default.http[0]!;
  if (!env('ARKIV_RPC_URL') && !env('ARKIV_ACCESS_KEY'))
    warn('no ARKIV_ACCESS_KEY: using the public, rate-limited endpoint');
  await chain(
    'Arkiv RPC',
    arkivUrl,
    env('ARKIV_CHAIN_ID') ? Number(env('ARKIV_CHAIN_ID')) : undefined,
    [
      ['registry', account('REGISTRY_KEY')],
      ['gateway', account('GATEWAY_KEY')],
    ],
    'gas token',
  );

  console.log('\nHedera');
  const hedera = await chain(
    'Hedera RPC',
    env('HEDERA_RPC_URL') ?? 'https://testnet.hashio.io/api',
    Number(env('HEDERA_CHAIN_ID') ?? ATS_HEDERA_TESTNET.chainId),
    [
      ['issuer', account('HEDERA_ISSUER_KEY')],
      ['relayer', account('HEDERA_RELAYER_KEY')],
      ['inspector', account('HEDERA_INSPECTOR_KEY')],
    ],
    'HBAR',
  );
  if (hedera) {
    const contracts: Array<[string, string | undefined, string]> = [
      ['ATS factory', env('HEDERA_ATS_FACTORY') ?? ATS_HEDERA_TESTNET.factory, ''],
      ['ATS resolver', env('HEDERA_ATS_RESOLVER') ?? ATS_HEDERA_TESTNET.resolver, ''],
      ['custody oracle', env('HEDERA_ORACLE'), 'HEDERA_ORACLE is not set — run `pnpm deploy:hedera`'],
      ['receipt market', env('HEDERA_MARKET'), 'HEDERA_MARKET is not set — run `pnpm deploy:hedera`'],
    ];
    for (const [name, address, missing] of contracts) {
      if (!address) {
        bad(missing);
        continue;
      }
      const code = await hedera.getCode({ address: address as Hex }).catch(() => undefined);
      if (code && code !== '0x') ok(`${name} at ${address}`);
      else bad(`${name}: nothing is deployed at ${address}`);
    }
  }

  console.log('\n0G Compute (decisions)');
  const router = env('ZG_ROUTER_URL') ?? 'https://router-api.0g.ai/v1';
  const standIn = env('ZG_MODE') === 'mock';
  if (standIn)
    warn('ZG_MODE=mock: decisions come from the stand-in and are recorded as dev-mock, never as 0G');
  else if (!env('ZG_API_KEY')) bad('ZG_API_KEY is not set');
  try {
    const response = await fetch(`${router}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) bad(`${router}/models answered HTTP ${response.status}`);
    else {
      const catalog = ((await response.json()) as { data?: Array<Record<string, any>> }).data ?? [];
      const vision = catalog
        .filter((model) => model.architecture?.input_modalities?.includes('image'))
        .map((model) => String(model.id));
      ok(`router answers: ${catalog.length} models, ${vision.length} accept images`);
      // Vision-language models first: they are what the seal check wants.
      const ranked = [...vision].sort((x, y) => Number(/vl|vision/.test(y)) - Number(/vl|vision/.test(x)));
      const some = `${ranked.slice(0, 10).join(', ') || 'none listed'}${ranked.length > 10 ? `, … and ${ranked.length - 10} more` : ''}`;
      const chosen = env('ZG_MODEL');
      if (!chosen) bad(`ZG_MODEL is not set. Models that accept images include: ${some}`);
      else if (!vision.includes(chosen))
        bad(`ZG_MODEL "${chosen}" is not an image model in the catalog. Try one of: ${some}`);
      else ok(`model ${chosen} accepts images`);
    }
  } catch (error) {
    bad(`0G router is unreachable: ${reason(error)}`);
  }

  console.log('\n0G Storage (episode logs)');
  if (env('ZG_STORAGE') === 'local') {
    warn('ZG_STORAGE=local: episode logs stay on this machine instead of 0G Storage');
  } else {
    await chain(
      '0G chain RPC',
      env('ZG_STORAGE_RPC_URL') ?? 'https://evmrpc-testnet.0g.ai',
      undefined,
      [['storage payer', account('ZG_STORAGE_KEY')]],
      '0G',
    );
    try {
      const indexer = env('ZG_STORAGE_INDEXER_URL') ?? 'https://indexer-storage-testnet-turbo.0g.ai';
      await fetch(indexer, { signal: AbortSignal.timeout(15_000) });
      ok(`storage indexer answers (${indexer})`);
    } catch (error) {
      bad(`storage indexer is unreachable: ${reason(error)}`);
    }
  }

  console.log('\nGateway');
  const attestor = account('ATTESTOR_KEY');
  if (attestor) ok(`attestor ${attestor.address} (signs decisions; needs no funds)`);
  if (!env('ADMIN_TOKEN')) warn('ADMIN_TOKEN is not set: the admin API will be disabled');

  console.log(failures === 0 ? '\nReady.' : `\n${failures} problem(s) to fix.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
