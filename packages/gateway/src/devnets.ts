/**
 * `pnpm devnets` — the three local stand-ins with NO gateway, plus an env file that points a
 * gateway at them. It exists to rehearse the testnet commands before spending testnet funds:
 *
 *   pnpm devnets                                  # terminal 1: chains + stand-in model
 *   ENV_FILE=.env.rehearsal pnpm doctor           # terminal 2: the same checks as for testnet
 *   ENV_FILE=.env.rehearsal pnpm demo --live      #             the same command as for testnet
 *
 * Everything `--live` does then goes through the configuration path — `.env`, the adapters for
 * real networks — and only the endpoints differ. The keys in the file are anvil's public
 * development keys: worthless anywhere else, so the file is safe to leave on disk.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_MODEL, startArkivDevnet, startHederaDevnet, startMockZgRouter } from '@pinky/devnet';
import { privateKeyToAccount } from 'viem/accounts';
import { devKey } from './local';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORTS = { arkiv: 8645, arkivAnvil: 8646, hedera: 8745, zg: 8845 };

async function main(): Promise<void> {
  console.log('starting the local stand-ins (no gateway)…');
  const [arkiv, hedera, zg] = await Promise.all([
    startArkivDevnet({ port: PORTS.arkiv, anvilPort: PORTS.arkivAnvil, blockTime: 1 }),
    startHederaDevnet({ port: PORTS.hedera }),
    startMockZgRouter({ port: PORTS.zg }),
  ]);
  const stop = async () => {
    await Promise.allSettled([arkiv.stop(), hedera.stop(), zg.stop()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  const keys = { registry: devKey(6), gateway: devKey(7), attestor: devKey(8) };
  await arkiv.fund(privateKeyToAccount(keys.registry).address);
  await arkiv.fund(privateKeyToAccount(keys.gateway).address);

  const file = resolve(REPO_ROOT, '.env.rehearsal');
  writeFileSync(
    file,
    `# Written by \`pnpm devnets\`. Points a gateway at the local stand-ins, through the same
# configuration a testnet run uses. Keys are anvil's public development keys.
PORT=8787
DATA_DIR=.data/rehearsal-${Date.now()}
ADMIN_TOKEN=rehearsal-admin-token
GATEWAY_DEMO=true

REGISTRY_KEY=${keys.registry}
GATEWAY_KEY=${keys.gateway}
ATTESTOR_KEY=${keys.attestor}

ARKIV_RPC_URL=${arkiv.rpcUrl}
ARKIV_CHAIN_ID=${arkiv.chainId}

HEDERA_RPC_URL=${hedera.rpcUrl}
HEDERA_CHAIN_ID=${hedera.chainId}
HEDERA_ORACLE=${hedera.oracle}
HEDERA_MARKET=${hedera.market}
HEDERA_ISSUER_KEY=${hedera.accounts.issuer.privateKey}
HEDERA_RELAYER_KEY=${hedera.accounts.relayer.privateKey}
HEDERA_INSPECTOR_KEY=${hedera.accounts.inspector.privateKey}

# The stand-in model: decisions are recorded as dev-mock, never as 0G.
ZG_MODE=mock
ZG_ROUTER_URL=${zg.baseUrl}
ZG_API_KEY=local-dev
ZG_MODEL=${MOCK_MODEL}
ZG_STORAGE=local

DEMO_DEPOSITOR_KEY=${hedera.accounts.depositor.privateKey}
DEMO_BUYER_ADDRESS=${hedera.accounts.buyer.address}
`,
  );

  console.log(`
  Arkiv RPC    ${arkiv.rpcUrl}   chain ${arkiv.chainId}
  Hedera RPC   ${hedera.rpcUrl}   chain ${hedera.chainId}   (real ATS contracts)
  0G stand-in  ${zg.baseUrl}

  wrote ${file}

  In another terminal, rehearse the testnet commands against these:

      ENV_FILE=.env.rehearsal pnpm doctor
      ENV_FILE=.env.rehearsal pnpm demo --live --pause

  Ctrl-C stops the stand-ins.
`);
  await new Promise<never>(() => {});
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
