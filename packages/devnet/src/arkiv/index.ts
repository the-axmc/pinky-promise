/**
 * arkiv-devnet: a local stand-in for an Arkiv node, so the unmodified `@arkiv-network/sdk` can
 * create, change and query entities with no network, access key or faucet.
 *
 *   anvil (plain local chain)
 *     └─ ArkivDevEngine bytecode installed at 0x4400…0044   — accepts the SDK's `execute` calls
 *   JSON-RPC proxy  ← give this URL to the SDK
 *     ├─ arkiv_query / arkiv_getEntity / arkiv_getBlockTiming   — answered from a log-built replica
 *     └─ everything else                                        — forwarded to anvil
 *
 * It follows Arkiv's public JSON-RPC and write-transaction documentation and was checked against
 * the Rabdi testnet, but it is an emulation: see README.md for the known differences.
 */
import { type Chain, type Hex, defineChain, parseEther } from 'viem';
import { type Anvil, freePort, startAnvil } from './anvil';
import artifact from './engine.artifact.json';
import { ARKIV_ENGINE_ADDRESS } from './model';
import { type Proxy, startProxy } from './proxy';
import { type ChainRpc, EntityStore } from './store';

export { ARKIV_ENGINE_ADDRESS } from './model';

export type ArkivDevnetOptions = {
  /** Port of the JSON-RPC proxy (the URL SDK clients use). Default: a free port. */
  port?: number;
  /** Port of the underlying anvil. Default: a free port. */
  anvilPort?: number;
  /** Default 1337. Deliberately not Rabdi's 7794095, so a devnet key can never be replayed there. */
  chainId?: number;
  /** Seconds between blocks. Default 2, as on Rabdi. 0 mines a block per transaction. */
  blockTime?: number;
  /** Suppress anvil's output. Default true. */
  quiet?: boolean;
};

export type ArkivDevnet = {
  /** The proxy URL — give this to SDK clients. */
  rpcUrl: string;
  chainId: number;
  /** A viem chain whose default RPC is `rpcUrl`, for the SDK's createPublicClient/createWalletClient. */
  chain: Chain;
  /** The anvil URL, for debugging. It does not answer `arkiv_*` methods. */
  anvilUrl: string;
  /** Sets an account's balance (anvil_setBalance). Default 100 of the native token. */
  fund(address: Hex, ether?: string): Promise<void>;
  /** Mines empty blocks, e.g. to move past an entity's expiry. */
  mine(blocks?: number): Promise<void>;
  /** The current block number, straight from the chain (no client-side caching). */
  blockNumber(): Promise<bigint>;
  /** Restarts the proxy with an empty replica, which it then rebuilds from the chain's logs. */
  restartProxy(): Promise<void>;
  stop(): Promise<void>;
};

function chainRpc(url: string): ChainRpc {
  let id = 0;
  return async (method, params = []) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const answer = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (answer.error) throw new Error(`${method} failed: ${answer.error.message} (${answer.error.code})`);
    return answer.result;
  };
}

export async function startArkivDevnet(options: ArkivDevnetOptions = {}): Promise<ArkivDevnet> {
  const chainId = options.chainId ?? 1337;
  const blockTime = options.blockTime ?? 2;
  const quiet = options.quiet ?? true;

  const anvil: Anvil = await startAnvil({ port: options.anvilPort, chainId, blockTime, quiet });
  let proxy: Proxy | undefined;
  try {
    const rpc = chainRpc(anvil.url);
    await rpc('anvil_setCode', [ARKIV_ENGINE_ADDRESS, artifact.deployedBytecode]);

    const proxyPort = options.port ?? (await freePort());
    const launchProxy = () =>
      startProxy({ port: proxyPort, upstream: anvil.url, store: new EntityStore(rpc), rpc, chainId });
    proxy = await launchProxy();
    const rpcUrl = proxy.url;

    const chain = defineChain({
      id: chainId,
      name: 'Arkiv devnet',
      nativeCurrency: { name: 'Dev GLM', symbol: 'tGLM', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
      // viem derives its polling interval from this; without it every write waits ~4 s.
      blockTime: Math.max(blockTime, 1) * 1000,
      testnet: true,
    });

    return {
      rpcUrl,
      chainId,
      chain,
      anvilUrl: anvil.url,
      async fund(address, ether = '100') {
        await rpc('anvil_setBalance', [address, `0x${parseEther(ether).toString(16)}`]);
      },
      async mine(blocks = 1) {
        await rpc('anvil_mine', [`0x${blocks.toString(16)}`]);
      },
      async blockNumber() {
        return BigInt(await rpc('eth_blockNumber'));
      },
      async restartProxy() {
        await proxy?.close();
        proxy = await launchProxy();
      },
      async stop() {
        await proxy?.close();
        await anvil.stop();
      },
    };
  } catch (error) {
    await proxy?.close();
    await anvil.stop();
    throw error;
  }
}
