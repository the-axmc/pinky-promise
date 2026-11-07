/**
 * The one public face of a hosted demo: the buyer page, the journey controls, and only the parts
 * of the gateway a browser needs. The gateway itself stays bound to localhost behind this, so its
 * admin and device APIs are not reachable from the internet.
 *
 * With stand-in chains a browser cannot reach them directly, so their JSON-RPC is relayed here.
 * Both run with public development keys, so the relay allows reads, and transactions only from
 * the demo buyer: a visitor can buy and redeem, and cannot act as the oracle or the inspector.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { type Hex, recoverTransactionAddress } from 'viem';
import type { DemoStack } from './demo-stack';
import type { Journey } from './journey';

export type RpcNetwork = 'arkiv' | 'hedera';

const READS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'net_version',
  'web3_clientVersion',
]);
const ARKIV_READS = new Set(['arkiv_query', 'arkiv_getEntity', 'arkiv_getBlockTiming']);

/** Why this JSON-RPC call may not pass the relay, or undefined when it may. */
export async function refuseRpcCall(
  network: RpcNetwork,
  call: { method?: unknown; params?: unknown },
  buyer: string | undefined,
): Promise<string | undefined> {
  const method = typeof call?.method === 'string' ? call.method : '';
  if (READS.has(method)) return undefined;
  if (network === 'arkiv') return ARKIV_READS.has(method) ? undefined : `${method || 'that'} is not allowed`;
  if (method !== 'eth_sendRawTransaction') return `${method || 'that'} is not allowed`;
  const raw = Array.isArray(call.params) ? call.params[0] : undefined;
  if (!buyer || typeof raw !== 'string') return 'only the demo buyer may send transactions';
  try {
    const sender = await recoverTransactionAddress({ serializedTransaction: raw as Hex as never });
    return sender.toLowerCase() === buyer.toLowerCase()
      ? undefined
      : 'only the demo buyer may send transactions';
  } catch {
    return 'that transaction could not be read';
  }
}

export type ShowcaseBackend = {
  stack: DemoStack;
  journey: Journey;
  /** Who may drive the journey. Empty means anyone on stand-in chains, and nobody on live ones. */
  driveKey?: string;
};

export type ShowcaseAppOptions = {
  /** Undefined until the stack has started: the page shows "starting" until then. */
  backend: () => ShowcaseBackend | undefined;
  /** The built buyer page. */
  webDist?: string;
  /** Live networks spend real test funds on each onboarding. Per hour; default 20. */
  onboardingsPerHour?: number;
};

const sameKey = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function createShowcaseApp(options: ShowcaseAppOptions): Hono {
  const app = new Hono();
  app.use('*', cors());
  app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));
  app.get('/health', (c) => c.json({ ok: true, ready: Boolean(options.backend()) }));

  /** Every route below needs the stack up. */
  const up = (): ShowcaseBackend => {
    const backend = options.backend();
    if (!backend) throw new StartingError();
    return backend;
  };
  app.onError((error, c) => {
    if (error instanceof StartingError) return c.json({ error: 'the demo is starting' }, 503);
    console.error(error);
    return c.json({ error: 'internal error' }, 500);
  });

  const relay = async (url: string, request: Request): Promise<Response> => {
    const init: RequestInit = { method: request.method };
    if (request.method === 'POST') {
      init.body = await request.text();
      init.headers = { 'content-type': 'application/json' };
    }
    const response = await fetch(url, init);
    const headers = new Headers();
    for (const name of ['content-type', 'cache-control']) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  };

  // --- what the buyer page needs from the gateway ---------------------------------------------------

  app.get('/v1/config', async (c) => {
    const { stack } = up();
    const response = await fetch(`${stack.url}/v1/config`);
    const config = (await response.json()) as any;
    // Stand-in chains are on this server's localhost: the browser reaches them through the relay.
    if (!stack.live) {
      config.arkiv.rpcUrl = '/rpc/arkiv';
      config.hedera.rpcUrl = '/rpc/hedera';
    }
    return c.json(config);
  });

  app.get('/v1/episodes/:root', (c) => relay(`${up().stack.url}${c.req.path}`, c.req.raw));
  app.get('/v1/demo/lots/:assetId/view-key', (c) => relay(`${up().stack.url}${c.req.path}`, c.req.raw));

  const perHour = options.onboardingsPerHour ?? 20;
  let onboardings: number[] = [];
  app.post('/v1/demo/onboard', async (c) => {
    const { stack } = up();
    if (stack.live) {
      const hourAgo = Date.now() - 3_600_000;
      onboardings = onboardings.filter((at) => at > hourAgo);
      if (onboardings.length >= perHour)
        return c.json({ error: 'too many onboardings this hour: please try again later' }, 429);
      onboardings.push(Date.now());
    }
    return relay(`${stack.url}/v1/demo/onboard`, c.req.raw);
  });

  // --- stand-in chains ----------------------------------------------------------------------------

  app.post('/rpc/:network{arkiv|hedera}', async (c) => {
    const { stack } = up();
    if (stack.live) return c.json({ error: 'this demo uses the public networks' }, 404);
    const network = c.req.param('network') as RpcNetwork;
    const text = await c.req.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: 'not JSON' }, 400);
    }
    for (const call of Array.isArray(body) ? body : [body]) {
      const refused = await refuseRpcCall(network, call, stack.hedera.buyer);
      if (refused)
        return c.json({ jsonrpc: '2.0', id: call?.id ?? null, error: { code: -32601, message: refused } });
    }
    const target = network === 'arkiv' ? stack.arkiv.rpcUrl : stack.hedera.rpcUrl;
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  });

  // --- the journey --------------------------------------------------------------------------------

  const driving = (backend: ShowcaseBackend): 'open' | 'key' | 'off' =>
    backend.driveKey ? 'key' : backend.stack.live ? 'off' : 'open';

  app.get('/v1/showcase', (c) => {
    const backend = up();
    return c.json({
      ...backend.journey.status(),
      driving: driving(backend),
      decisions: backend.stack.decisions,
    });
  });

  const drive = (job: (journey: Journey) => boolean) => (c: any) => {
    const backend = up();
    const mode = driving(backend);
    if (mode === 'off') return c.json({ error: 'this demo is read-only' }, 403);
    if (mode === 'key' && !sameKey(c.req.header('x-drive-key') ?? '', backend.driveKey!))
      return c.json({ error: 'that key does not drive this demo' }, 401);
    return job(backend.journey)
      ? c.json({ ok: true }, 202)
      : c.json({ error: 'a step is already running, or the journey is over' }, 409);
  };
  app.post(
    '/v1/showcase/next',
    drive((journey) => journey.next()),
  );
  app.post(
    '/v1/showcase/restart',
    drive((journey) => journey.restart()),
  );

  // --- the buyer page -----------------------------------------------------------------------------

  // Nothing else of the gateway is exposed: no admin, no device API.
  app.all('/v1/*', (c) => c.json({ error: 'not found' }, 404));
  app.all('/rpc/*', (c) => c.json({ error: 'not found' }, 404));

  if (options.webDist && existsSync(options.webDist)) {
    const root = relative(process.cwd(), options.webDist) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('/*', serveStatic({ path: `${root}/index.html` }));
  }
  return app;
}

class StartingError extends Error {}
