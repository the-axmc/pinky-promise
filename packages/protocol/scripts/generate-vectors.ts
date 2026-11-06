/**
 * Writes the protocol test vectors to contracts/vectors/protocol-v1.json, where the Solidity
 * tests read them. Run after any change to a wire format: `pnpm --filter @pinky/protocol vectors`.
 * A unit test fails if the committed file is stale.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVectors } from '../src/vectors';

export const VECTORS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/vectors/protocol-v1.json',
);

export function renderVectors(): string {
  return JSON.stringify(buildVectors(), null, 2) + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(VECTORS_FILE), { recursive: true });
  writeFileSync(VECTORS_FILE, renderVectors());
  const vectors = buildVectors();
  console.log(
    `Wrote ${VECTORS_FILE}: ${vectors.readings.length} readings, ${vectors.policy.length} policy rows`,
  );
}
