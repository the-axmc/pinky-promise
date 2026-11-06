/**
 * Starts and stops the anvil process the devnet runs on. Only the process this module spawned
 * is ever signalled: nothing here looks for, or kills, other anvil instances.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

export type Anvil = {
  url: string;
  port: number;
  pid: number | undefined;
  stop(): Promise<void>;
};

export type AnvilOptions = {
  port?: number;
  chainId: number;
  /** Seconds between blocks. 0 or undefined mines a block per transaction (automine). */
  blockTime?: number;
  quiet?: boolean;
};

/** A TCP port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function rpcReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function startAnvil(options: AnvilOptions): Promise<Anvil> {
  const port = options.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(options.chainId)];
  if (options.blockTime !== undefined && options.blockTime > 0) args.push('--block-time', String(options.blockTime));
  args.push('--silent');

  let child: ChildProcess;
  let exited = false;
  let output = '';
  const spawned = new Promise<void>((resolve, reject) => {
    child = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('spawn', resolve);
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(
              'anvil was not found on PATH. The local Arkiv devnet runs on anvil, which ships with Foundry: ' +
                'install it with `curl -L https://foundry.paradigm.xyz | bash && foundryup`.',
            )
          : error,
      );
    });
  });
  await spawned;

  child!.stdout?.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
    if (!options.quiet) process.stdout.write(`[anvil] ${chunk}`);
  });
  child!.stderr?.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
    if (!options.quiet) process.stderr.write(`[anvil] ${chunk}`);
  });
  child!.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 20_000;
  while (!(await rpcReady(url))) {
    if (exited) {
      throw new Error(`anvil exited before it was ready (is port ${port} in use?). Output:\n${output.trim()}`);
    }
    if (Date.now() > deadline) {
      child!.kill('SIGKILL');
      throw new Error(`anvil did not answer on ${url} within 20 seconds. Output:\n${output.trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return {
    url,
    port,
    pid: child!.pid,
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited) return resolve();
        const force = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}
