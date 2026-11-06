/**
 * Runs the local Arkiv devnet until interrupted.
 *
 *   pnpm --filter @pinky/devnet arkiv [--port 8645] [--anvil-port 8646] [--chain-id 1337] [--block-time 2]
 *
 * The same settings can come from ARKIV_DEVNET_PORT, ARKIV_DEVNET_ANVIL_PORT,
 * ARKIV_DEVNET_CHAIN_ID and ARKIV_DEVNET_BLOCK_TIME. Flags win over the environment.
 */
import { startArkivDevnet } from './index';

function setting(flag: string, env: string, fallback: number): number {
  const index = process.argv.indexOf(`--${flag}`);
  const raw = index !== -1 ? process.argv[index + 1] : process.env[env];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`--${flag} must be a non-negative whole number, got "${raw}"`);
    process.exit(2);
  }
  return value;
}

const port = setting('port', 'ARKIV_DEVNET_PORT', 8645);
const anvilPort = setting('anvil-port', 'ARKIV_DEVNET_ANVIL_PORT', port + 1);
const chainId = setting('chain-id', 'ARKIV_DEVNET_CHAIN_ID', 1337);
const blockTime = setting('block-time', 'ARKIV_DEVNET_BLOCK_TIME', 2);

try {
  const devnet = await startArkivDevnet({ port, anvilPort, chainId, blockTime, quiet: true });
  console.log('Arkiv devnet is running (local emulation — not the real chain)');
  console.log(`  RPC URL    ${devnet.rpcUrl}   <- use this in the SDK`);
  console.log(`  chain id   ${devnet.chainId}`);
  console.log(`  block time ${blockTime === 0 ? 'one block per transaction' : `${blockTime} s`}`);
  console.log(`  anvil      ${devnet.anvilUrl}   (no arkiv_* methods there)`);
  console.log('Press Ctrl-C to stop.');

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, stopping anvil ...`);
    devnet.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
