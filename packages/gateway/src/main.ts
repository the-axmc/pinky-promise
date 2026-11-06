/**
 * The gateway against real networks: `pnpm gateway` (after `cp .env.example .env`).
 * For everything on one machine with no keys, use `pnpm demo` instead.
 */
import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { assembleGateway } from './assemble';
import { ConfigError, loadEnvFile, readConfig } from './config';
import { createApp } from './http';

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  const config = readConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const log = (event: string, detail?: Record<string, unknown>) =>
    console.log(`${new Date().toISOString().slice(11, 19)}  ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
  const { gateway, zg, publicConfig } = assembleGateway(config, log);

  console.log(`pinky gateway${envFile ? ` (config: ${envFile})` : ''}
  Arkiv    ${publicConfig.arkiv.rpcUrl}  chain ${publicConfig.arkiv.chainId}  (published endpoint; the access key stays here)
           registry ${publicConfig.arkiv.registry}   gateway ${publicConfig.gateway}
  Hedera   ${publicConfig.hedera.rpcUrl}  chain ${publicConfig.hedera.chainId}
           oracle ${publicConfig.hedera.oracle}   market ${publicConfig.hedera.market}
  0G       ${config.zg.routerUrl}  model ${config.zg.model}
           attestor ${publicConfig.attestor}`);

  // 0G must be usable, or every handoff would simply stay PENDING. Say so up front.
  const preflight = await zg.preflight();
  if (!preflight.ok) console.warn(`\n  WARNING — 0G is not ready: ${preflight.problems.join('; ')}\n  Handoffs will stay PENDING until it is. Run \`pnpm doctor\` for details.\n`);
  if (!config.adminToken) console.warn('  ADMIN_TOKEN is not set: the admin API (venues, devices, lots) is disabled.');

  const app = createApp(gateway, { publicConfig, ...(config.adminToken ? { adminToken: config.adminToken } : {}) });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  gateway.start(1_000);
  console.log(`\n  listening on http://${config.host}:${config.port}\n`);

  const stop = async () => {
    console.log('stopping…');
    await gateway.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `\n${error.message}\n\nSee .env.example.` : error);
  process.exit(1);
});
