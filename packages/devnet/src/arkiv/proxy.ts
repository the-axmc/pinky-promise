/**
 * The devnet's JSON-RPC endpoint: the URL SDK clients (and the browser) are given.
 *
 * It answers the three `arkiv_*` read methods from the entity replica and forwards every other
 * call — the standard Ethereum methods, including `eth_sendRawTransaction` to the engine — to
 * anvil unchanged. Single requests and batches are both handled; a batch may mix the two kinds.
 *
 * CORS is open, because the buyer page calls this from a browser. Any request path is accepted:
 * Rabdi carries the access key as a path segment, so a URL shaped like the real one still works.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { arkivGetBlockTiming, arkivGetEntity, arkivQuery } from './methods';
import { RpcError } from './query/errors';
import type { ChainRpc, EntityStore } from './store';

export type Proxy = { url: string; port: number; close(): Promise<void> };

export type ProxyOptions = {
  port?: number;
  /** The anvil URL everything that is not an `arkiv_*` method goes to. */
  upstream: string;
  store: EntityStore;
  rpc: ChainRpc;
  chainId: number;
};

type Call = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RpcError(-32600, 'request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  response.end(text);
}

function isArkivMethod(call: Call): boolean {
  return typeof call?.method === 'string' && call.method.startsWith('arkiv_');
}

export async function startProxy(options: ProxyOptions): Promise<Proxy> {
  const { upstream, store, rpc, chainId } = options;

  async function answerLocally(call: Call): Promise<unknown> {
    const id = call.id ?? null;
    try {
      const params = Array.isArray(call.params) ? call.params : [];
      let result: unknown;
      switch (call.method) {
        case 'arkiv_query':
          result = await arkivQuery(store, params);
          break;
        case 'arkiv_getEntity':
          result = await arkivGetEntity(store, params);
          break;
        case 'arkiv_getBlockTiming':
          result = await arkivGetBlockTiming(rpc);
          break;
        default:
          throw new RpcError(-32601, `the method ${String(call.method)} does not exist`);
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (error instanceof RpcError) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: error.code,
            message: error.message,
            ...(error.data !== undefined && { data: error.data }),
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async function forward(body: unknown): Promise<unknown> {
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return text === '' ? undefined : JSON.parse(text);
  }

  async function handle(payload: unknown): Promise<unknown> {
    if (!Array.isArray(payload)) {
      return isArkivMethod(payload as Call) ? answerLocally(payload as Call) : forward(payload);
    }
    if (payload.length === 0) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'empty batch' } };
    }
    // A batch may mix both kinds: answer ours here, send the rest upstream as one batch, and put
    // the answers back in request order.
    const calls = payload as Call[];
    const upstreamIndexes = calls.flatMap((call, index) => (isArkivMethod(call) ? [] : [index]));
    const results = new Array<unknown>(calls.length);
    const pending: Promise<void>[] = calls.flatMap((call, index) =>
      isArkivMethod(call) ? [answerLocally(call).then((answer) => void (results[index] = answer))] : [],
    );
    if (upstreamIndexes.length > 0) {
      pending.push(
        forward(upstreamIndexes.map((index) => calls[index])).then((answers) => {
          const list = Array.isArray(answers) ? answers : [];
          upstreamIndexes.forEach((index, position) => {
            // Batch answers may come back in any order; match them to requests by id.
            const wanted = calls[index]!.id;
            results[index] = list.find((answer) => answer?.id === wanted) ?? list[position];
          });
        }),
      );
    }
    await Promise.all(pending);
    return results.filter((answer) => answer !== undefined);
  }

  const server: Server = createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS);
      response.end();
      return;
    }
    if (request.method === 'GET') {
      send(response, 200, {
        name: 'arkiv-devnet',
        chainId,
        note: 'local stand-in for an Arkiv node; POST JSON-RPC here',
      });
      return;
    }
    if (request.method !== 'POST') {
      send(response, 405, { error: 'use POST' });
      return;
    }
    readBody(request)
      .then(async (text) => {
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          send(response, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
          return;
        }
        send(response, 200, await handle(payload));
      })
      .catch((error) => {
        const code = error instanceof RpcError ? error.code : -32603;
        send(response, 200, {
          jsonrpc: '2.0',
          id: null,
          error: { code, message: error instanceof Error ? error.message : String(error) },
        });
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive connections would otherwise hold the server open.
        server.closeAllConnections();
      }),
  };
}
