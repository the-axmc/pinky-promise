/**
 * Starts and stops a local anvil chain (part of Foundry). Both local chains — the Hedera
 * stand-in and the Arkiv dev node — are anvil instances.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

export type AnvilInstance = { url: string; port: number; chainId: number; stop(): Promise<void> };

export type AnvilOptions = {
  port?: number;
  chainId?: number;
  /** Seconds between blocks. Omit to mine a block per transaction. */
  blockTime?: number;
  /** Print anvil's own output. */
  verbose?: boolean;
};

/** A TCP port that is free right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Sends many calls in one HTTP request. Throws on the first error. */
export async function rpcBatch(
  url: string,
  calls: Array<{ method: string; params: unknown[] }>,
): Promise<void> {
  if (calls.length === 0) return;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: '2.0', id, ...call }))),
  });
  const body = (await response.json()) as Array<{ id: number; error?: { message: string } }>;
  const failed = body.find((entry) => entry.error);
  if (failed) throw new Error(`${calls[failed.id]!.method}: ${failed.error!.message}`);
}

export async function startAnvil(options: AnvilOptions = {}): Promise<AnvilInstance> {
  const port = options.port ?? (await freePort());
  const chainId = options.chainId ?? 31337;
  const args = ['--port', String(port), '--chain-id', String(chainId), '--host', '127.0.0.1'];
  if (options.blockTime) args.push('--block-time', String(options.blockTime));

  let child: ChildProcess;
  try {
    child = spawn('anvil', args, { stdio: ['ignore', options.verbose ? 'inherit' : 'ignore', 'pipe'] });
  } catch {
    throw new Error(
      'could not start anvil. Install Foundry: https://book.getfoundry.sh/getting-started/installation',
    );
  }
  let stderr = '';
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const failed = new Promise<never>((_, reject) => {
    child.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new Error(
              'anvil not found on PATH. Install Foundry: https://book.getfoundry.sh/getting-started/installation',
            )
          : error,
      ),
    );
    child.once('exit', (code) =>
      reject(new Error(`anvil exited with code ${code}: ${stderr.trim().slice(-400)}`)),
    );
  });
  failed.catch(() => {});

  const url = `http://127.0.0.1:${port}`;
  const ready = (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await rpc(url, 'eth_chainId');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error(`anvil did not answer on ${url}`);
  })();
  await Promise.race([ready, failed]);

  // A chain must not outlive the process that started it: an orphan would keep the port and make
  // the next start fail in a confusing way.
  const killOnExit = () => void child.kill('SIGKILL');
  process.once('exit', killOnExit);

  return {
    url,
    port,
    chainId,
    stop: () =>
      new Promise<void>((resolve) => {
        process.removeListener('exit', killOnExit);
        if (child.exitCode !== null) return resolve();
        child.removeAllListeners('exit');
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
