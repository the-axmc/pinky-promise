/**
 * Compiles the geofence circuit and derives its verification key.
 *
 *   pnpm --filter @pinky/zk build:circuit
 *
 * No `nargo` or `bb` binary is needed: the Noir compiler runs as WebAssembly and Barretenberg
 * ships with bb.js. The outputs are committed, so only someone who edits the circuit has to run
 * this, and a unit test fails if the committed artifacts no longer match the source.
 *
 *   artifacts/geofence.circuit.json   bytecode + ABI, needed to prove
 *   artifacts/geofence.vk.json        verification key, all a verifier needs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { compile, createFileManager } from '@noir-lang/noir_wasm';
import { GEOFENCE_CIRCUIT, VERIFIER_TARGET } from '../src/constants';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CIRCUIT_DIR = resolve(ROOT, 'circuits/geofence');
export const CIRCUIT_ARTIFACT = resolve(ROOT, 'artifacts/geofence.circuit.json');
export const VK_ARTIFACT = resolve(ROOT, 'artifacts/geofence.vk.json');

export type CompiledGeofence = {
  noir_version: string;
  hash: string | number;
  abi: unknown;
  bytecode: string;
};

/** Compiles the circuit source. Deterministic for a given Noir version. */
export async function compileGeofence(): Promise<CompiledGeofence> {
  const compiled = await compile(createFileManager(CIRCUIT_DIR), undefined, () => {});
  const { noir_version, hash, abi, bytecode } = compiled.program as CompiledGeofence;
  return { noir_version, hash, abi, bytecode };
}

async function main() {
  const circuit = await compileGeofence();

  const api = await Barretenberg.new();
  let vk: Uint8Array;
  try {
    vk = await new UltraHonkBackend(circuit.bytecode, api).getVerificationKey({
      verifierTarget: VERIFIER_TARGET,
    });
  } finally {
    await api.destroy();
  }

  const bbVersion = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/@aztec/bb.js/package.json'), 'utf8'))
    .version as string;

  mkdirSync(dirname(CIRCUIT_ARTIFACT), { recursive: true });
  writeFileSync(CIRCUIT_ARTIFACT, JSON.stringify({ circuit: GEOFENCE_CIRCUIT, ...circuit }) + '\n');
  writeFileSync(
    VK_ARTIFACT,
    JSON.stringify(
      {
        circuit: GEOFENCE_CIRCUIT,
        noirVersion: circuit.noir_version,
        bbVersion,
        verifierTarget: VERIFIER_TARGET,
        vkHash: `0x${createHash('sha256').update(vk).digest('hex')}`,
        vk: `0x${Buffer.from(vk).toString('hex')}`,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Compiled ${GEOFENCE_CIRCUIT} with Noir ${circuit.noir_version}, bb.js ${bbVersion}: ` +
      `bytecode ${circuit.bytecode.length} chars, vk ${vk.length} bytes`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
