/**
 * What the buyer page needs to know to read the three networks itself. It comes from the
 * gateway's public endpoint, but nothing after this is taken on the gateway's word: readings,
 * decisions and proofs are read from Arkiv, token state from Hedera, and each is checked here.
 */
import { createPublicClient as createArkivClient } from '@arkiv-network/sdk';
import type { Address } from '@pinky/protocol';
import { type PublicClient, createPublicClient, defineChain, http } from 'viem';

export type PublicConfig = {
  arkiv: { rpcUrl: string; chainId: number; registry: Address; explorerUrl?: string };
  hedera: { rpcUrl: string; chainId: number; oracle: Address; market: Address; explorerUrl?: string };
  zg: { mode: 'router' | 'mock'; model: string; storage: '0g' | 'local'; storageExplorerUrl?: string };
  attestor: Address;
  gateway: Address;
  demo: boolean;
};

export type Context = {
  gatewayUrl: string;
  config: PublicConfig;
  /** Reads Arkiv entities. */
  arkiv: { select: (...args: any[]) => any };
  /** Reads Hedera contracts. */
  hedera: PublicClient;
  hederaChain: ReturnType<typeof defineChain>;
};

export async function connect(gatewayUrl: string): Promise<Context> {
  const base = gatewayUrl.replace(/\/$/, '');
  const response = await fetch(`${base}/v1/config`);
  if (!response.ok) throw new Error(`the gateway at ${base} answered ${response.status}`);
  const config = (await response.json()) as PublicConfig;
  // A hosted demo relays its stand-in chains through its own origin, as relative paths.
  config.arkiv.rpcUrl = new URL(config.arkiv.rpcUrl, `${base}/`).href;
  config.hedera.rpcUrl = new URL(config.hedera.rpcUrl, `${base}/`).href;

  const arkivChain = defineChain({
    id: config.arkiv.chainId,
    name: 'Arkiv',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.arkiv.rpcUrl] } },
  });
  const hederaChain = defineChain({
    id: config.hedera.chainId,
    name: config.hedera.chainId === 31337 ? 'Hedera (local stand-in)' : 'Hedera',
    nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
    rpcUrls: { default: { http: [config.hedera.rpcUrl] } },
  });
  return {
    gatewayUrl: base,
    config,
    arkiv: createArkivClient({ chain: arkivChain, transport: http() }) as never,
    hedera: createPublicClient({
      chain: hederaChain,
      transport: http(),
      pollingInterval: config.hedera.chainId === 31337 ? 200 : 2_000,
    }),
    hederaChain,
  };
}

/** Link to an account, contract or transaction on the block explorer, when there is one. */
export function explorerLink(
  config: PublicConfig,
  kind: 'contract' | 'account' | 'transaction',
  id: string,
): string | undefined {
  return config.hedera.explorerUrl ? `${config.hedera.explorerUrl}/${kind}/${id}` : undefined;
}
