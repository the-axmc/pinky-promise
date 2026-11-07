/**
 * `pnpm showcase` — a hosted demo on one port: the buyer page, plus controls on the page that
 * walk a lot through its journey, for a visitor with no terminal.
 *
 *   pnpm showcase              stand-in chains and model on this machine; needs no keys
 *   pnpm showcase --live       the networks named in .env (`SHOWCASE_MODE=live` does the same)
 *
 * Build the page first: `pnpm --filter @pinky/web build`. PORT (default 8080) is the public port;
 * the gateway stays on localhost behind it (see showcase-app.ts).
 *
 * Stand-ins prepare a lot at boot and anyone can drive them. On live networks a new lot costs test
 * funds, so nothing is spent at boot, and driving needs SHOWCASE_DRIVE_KEY: open the page once
 * with `?drive=<key>` to get the controls. Without the key a visitor can read what is on chain.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ConfigError } from './config';
import { type DemoStack, liveDemoStack, localDemoStack } from './demo-stack';
import { Journey } from './journey';
import { type ShowcaseBackend, createShowcaseApp } from './showcase-app';

const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
/** Where the gateway listens, behind the public port. */
const GATEWAY_PORT = '8787';

async function main(): Promise<void> {
  const publicPort = Number(process.env.PORT ?? 8080);
  const host = process.env.SHOWCASE_HOST ?? '0.0.0.0';
  const live = process.argv.includes('--live') || process.env.SHOWCASE_MODE === 'live';

  let backend: ShowcaseBackend | undefined;
  const app = createShowcaseApp({ backend: () => backend, webDist: WEB_DIST });
  const server = serve({ fetch: app.fetch, port: publicPort, hostname: host });
  console.log(
    `showcase on http://${host}:${publicPort} — starting ${live ? 'on the live networks' : 'the stand-ins'}…`,
  );

  // The page and the health check answer from here on; the page shows "starting" meanwhile.
  process.env.PORT = GATEWAY_PORT;
  process.env.HOST = '127.0.0.1';
  // Browsers reach stand-ins only through the relay, so their own ports do not matter.
  const stack: DemoStack = await (live ? liveDemoStack({}) : localDemoStack({ anyPorts: true }));
  const journey = new Journey(stack, { echo: (line) => console.log(line) });
  const driveKey = process.env.SHOWCASE_DRIVE_KEY;
  backend = { stack, journey, ...(driveKey ? { driveKey } : {}) };
  console.log(`ready. decisions: ${stack.decisions}`);

  const stop = async () => {
    await journey.stop().catch(() => {});
    await stack.stop().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  if (!live) journey.restart();
  else if (!driveKey) console.log('SHOWCASE_DRIVE_KEY is not set: this demo is read-only.');
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(
      `\n${error.message}\n\nSee .env.example; \`pnpm doctor\` checks it without sending anything.`,
    );
  } else console.error(error);
  process.exit(1);
});
