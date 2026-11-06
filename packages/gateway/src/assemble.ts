/**
 * Builds the gateway for real networks from its configuration: the same Gateway class the local
 * stack runs, with the Rabdi/Arkiv chain, the Hedera JSON-RPC relay, the 0G Compute Router and
 * 0G Storage behind it.
 */
import { join } from 'node:path';
import { rabdi } from '@arkiv-network/sdk/chains';
import { ArkivAdapter } from './arkiv/adapter';
import { SignRequestQueue } from './arkiv/sign-requests';
import type { GatewayConfig } from './config';
import { Gateway, type GatewayOptions } from './gateway';
import { HederaAdapter } from './hedera/adapter';
import type { PublicConfig } from './http';
import { GatewayStore } from './store';
import { ZgDecisionClient } from './zg/decision';
import { ZgEpisodeStore } from './zg/storage';

export type Assembled = {
  gateway: Gateway;
  arkiv: ArkivAdapter;
  hedera: HederaAdapter;
  zg: ZgDecisionClient;
  episodes: ZgEpisodeStore;
  publicConfig: PublicConfig;
};

/**
 * The Arkiv endpoint that is published to browsers. Never the gateway's own: on Rabdi the
 * access key is part of the URL, and publishing it would hand the operator's key to everyone.
 */
export function publicArkivRpcUrl(config: Pick<GatewayConfig, 'arkiv'>): string {
  if (config.arkiv.publicRpcUrl) return config.arkiv.publicRpcUrl;
  if (config.arkiv.rpcUrl) return config.arkiv.rpcUrl; // a custom or local node carries no key
  return rabdi({ accessKey: '' }).rpcUrls.default.http[0]!;
}

export function assembleGateway(config: GatewayConfig, log?: GatewayOptions['log']): Assembled {
  const signRequests = new SignRequestQueue(120_000);
  const arkiv = new ArkivAdapter(
    {
      ...(config.arkiv.rpcUrl ? { rpcUrl: config.arkiv.rpcUrl } : {}),
      ...(config.arkiv.chainId ? { chainId: config.arkiv.chainId } : {}),
      ...(config.arkiv.accessKey ? { accessKey: config.arkiv.accessKey } : {}),
      registryKey: config.keys.registry,
      gatewayKey: config.keys.gateway,
    },
    signRequests,
  );
  const hedera = new HederaAdapter({
    rpcUrl: config.hedera.rpcUrl,
    chainId: config.hedera.chainId,
    factory: config.hedera.factory,
    resolver: config.hedera.resolver,
    oracle: config.hedera.oracle,
    market: config.hedera.market,
    issuerKey: config.hedera.issuerKey,
    relayerKey: config.hedera.relayerKey,
    inspectorKey: config.hedera.inspectorKey,
    explorerUrl: config.hedera.explorerUrl,
  });
  const zg = new ZgDecisionClient({
    mode: 'router',
    baseUrl: config.zg.routerUrl,
    apiKey: config.zg.apiKey,
    model: config.zg.model,
    verifyTee: config.zg.verifyTee,
  });
  const episodes = new ZgEpisodeStore({
    rpcUrl: config.zg.storage.rpcUrl,
    indexerUrl: config.zg.storage.indexerUrl,
    privateKey: config.zg.storage.privateKey,
  });
  const store = new GatewayStore(join(config.dataDir, 'gateway.json'));
  const gateway = new Gateway(arkiv, hedera, zg, episodes, signRequests, store, {
    attestorKey: config.keys.attestor,
    registryKey: config.keys.registry,
    geofenceProofs: config.geofenceProofs,
    ...(log ? { log } : {}),
  });
  const publicConfig: PublicConfig = {
    arkiv: {
      rpcUrl: publicArkivRpcUrl(config),
      chainId: arkiv.chain.id,
      registry: arkiv.registry,
      ...(config.arkiv.explorerUrl ? { explorerUrl: config.arkiv.explorerUrl } : {}),
    },
    hedera: {
      rpcUrl: config.hedera.rpcUrl,
      chainId: config.hedera.chainId,
      oracle: config.hedera.oracle,
      market: config.hedera.market,
      explorerUrl: config.hedera.explorerUrl,
    },
    zg: {
      mode: 'router',
      model: config.zg.model,
      storage: '0g',
      ...(config.zg.storage.explorerUrl ? { storageExplorerUrl: config.zg.storage.explorerUrl } : {}),
    },
    attestor: gateway.attestor,
    gateway: arkiv.gateway,
    demo: config.demo,
  };
  return { gateway, arkiv, hedera, zg, episodes, publicConfig };
}
