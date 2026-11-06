/**
 * The private side of a lot. Arkiv shows only whether each reading was in range; the values,
 * the seal photo and the model's full answer are in an encrypted episode log on 0G Storage,
 * readable with the lot's view key.
 */
import {
  type EpisodeLog,
  type Hex,
  decodeReading,
  fromHex,
  openEpisode,
  verifyReading,
} from '@pinky/protocol';
import type { Context } from './config';

export type RawReading = { seq: number; ts: number; tempCenti: number; rhCenti: number };

export type OpenedEpisode = {
  root: Hex;
  log: EpisodeLog;
  /** The window's readings, each re-verified against the device's signature. */
  readings: RawReading[];
  photo?: { mime: string; base64: string };
};

export async function fetchEpisode(ctx: Context, root: Hex, viewKey: Hex): Promise<OpenedEpisode> {
  const response = await fetch(`${ctx.gatewayUrl}/v1/episodes/${root}`);
  if (!response.ok) throw new Error(`episode ${root.slice(0, 10)}… is not available (${response.status})`);
  const log = openEpisode(new Uint8Array(await response.arrayBuffer()), viewKey);
  const readings = log.readings.map((signed) => {
    verifyReading(signed); // throws unless the device named inside signed it
    const reading = decodeReading(fromHex(signed.payload));
    return { seq: reading.seq, ts: reading.ts, tempCenti: reading.tempCenti, rhCenti: reading.rhCenti };
  });
  return { root, log, readings, ...(log.seal.photo ? { photo: log.seal.photo } : {}) };
}

/** Demo gateways hand out view keys; a real one gives them only to parties entitled to raw data. */
export async function fetchDemoViewKey(ctx: Context, assetId: string): Promise<Hex> {
  const response = await fetch(`${ctx.gatewayUrl}/v1/demo/lots/${assetId}/view-key`);
  if (!response.ok) throw new Error('this gateway does not hand out view keys');
  return ((await response.json()) as { viewKey: Hex }).viewKey;
}
