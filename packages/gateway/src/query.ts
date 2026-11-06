/**
 * One runnable Arkiv query, straight against the chain:
 *
 *   pnpm arkiv:query --lot LOT-42 --out-of-range
 *
 * "All readings for lot X where in_range = false" — the question the plan says only Arkiv
 * answers. It asks the gateway where the Arkiv node is and which registry it uses; everything
 * else is read from Arkiv, and the answer is scoped to entities the lot's own device created.
 */
import { createPublicClient } from '@arkiv-network/sdk';
import { fetchLot, fetchReadings } from '@pinky/protocol/arkiv';
import { defineChain, http } from 'viem';
import type { PublicConfig } from './http';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1] && !args[index + 1]!.startsWith('--') ? args[index + 1]! : 'true';
};

async function main(): Promise<void> {
  const gateway = (flag('gateway') ?? process.env.GATEWAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
  const assetId = flag('lot') ?? 'LOT-42';
  const config = (await (await fetch(`${gateway}/v1/config`)).json()) as PublicConfig;
  const chain = defineChain({
    id: config.arkiv.chainId,
    name: 'Arkiv',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.arkiv.rpcUrl] } },
  });
  const reader = createPublicClient({ chain, transport: http() });

  const lot = await fetchLot(reader, config.arkiv.registry, assetId);
  if (!lot) throw new Error(`no lot ${assetId} written by registry ${config.arkiv.registry} on chain ${config.arkiv.chainId}`);
  console.log(`Arkiv chain ${config.arkiv.chainId} at ${config.arkiv.rpcUrl}

writer wallets
  registry (Device, Venue, Lot)   ${config.arkiv.registry}
  device   (Reading, Checkpoint)  ${lot.deviceId}
  gateway  (GeoProof)             ${lot.gateway}
`);

  const onlyOutOfRange = flag('out-of-range') !== undefined;
  // The same query with the SDK's builder:
  //   reader.select().from(Readings)
  //     .where(and(eq('asset_id', assetId), eq('in_range', false)))
  //     .createdBy(lot.deviceId).orderBy(asc('seq'))
  const readings = await fetchReadings(reader, { assetId, device: lot.deviceId, onlyOutOfRange });
  console.log(`readings of ${assetId} created by its device${onlyOutOfRange ? ' where in_range = false' : ''}: ${readings.length}`);
  for (const reading of readings) {
    console.log(
      `  #${String(reading.seq).padEnd(4)} ${new Date(reading.ts * 1000).toISOString()}  in_range=${String(reading.inRange).padEnd(5)}  digest ${reading.digest}  entity ${reading.entityKey}`,
    );
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
