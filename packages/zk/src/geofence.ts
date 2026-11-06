/**
 * Prover and verifier for the geofence circuit.
 *
 * Proving needs the circuit bytecode and happens on the gateway (about two seconds natively).
 * Verifying needs only the verification key and runs anywhere, including the buyer's browser.
 * Both share one Barretenberg instance per process, created on first use.
 */
import { Barretenberg, UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';
import { type Hex, ProtocolError, fromHex, sha256, toHex } from '@pinky/protocol';
import circuitArtifact from '../artifacts/geofence.circuit.json' with { type: 'json' };
import vkArtifact from '../artifacts/geofence.vk.json' with { type: 'json' };
import { GEOFENCE_CIRCUIT, PUBLIC_INPUT_COUNT, VERIFIER_TARGET } from './constants';
import { type GeofenceStatement, type GeofenceWitness, circuitInputs, publicInputsFor } from './inputs';

/** SHA-256 of the verification key: identifies the exact circuit a proof was made for. */
export const GEOFENCE_VK_HASH = vkArtifact.vkHash as Hex;
export const GEOFENCE_VK: Uint8Array = fromHex(vkArtifact.vk);

export type GeofenceProof = {
  circuit: typeof GEOFENCE_CIRCUIT;
  vkHash: Hex;
  /** The proof bytes (about 8.8 KB). Public inputs are not included: verifiers rebuild them. */
  proof: Uint8Array;
};

let barretenberg: Promise<Barretenberg> | undefined;

/** The shared Barretenberg instance. `threads: 1` avoids SharedArrayBuffer (plain browsers). */
export function getBarretenberg(options?: { threads?: number }): Promise<Barretenberg> {
  barretenberg ??= Barretenberg.new(options);
  return barretenberg;
}

/** Releases the Barretenberg worker so a script can exit. Safe to call when never started. */
export async function destroyBarretenberg(): Promise<void> {
  if (!barretenberg) return;
  const api = await barretenberg;
  barretenberg = undefined;
  await api.destroy();
}

/**
 * Proves that the reading behind `statement.digest` was signed by `statement.publicKey` and
 * taken inside `statement.box`. Throws {@link ProtocolError} if that is not true — an
 * out-of-box position, a wrong salt or a foreign signature has no valid witness.
 */
export async function proveGeofence(statement: GeofenceStatement, witness: GeofenceWitness): Promise<GeofenceProof> {
  const inputs = circuitInputs(statement, witness);
  let solved: Uint8Array;
  try {
    ({ witness: solved } = await new Noir(circuitArtifact as never).execute(inputs));
  } catch (error) {
    throw new ProtocolError(`geofence statement cannot be proven: ${(error as Error).message}`);
  }

  const api = await getBarretenberg();
  const backend = new UltraHonkBackend(circuitArtifact.bytecode, api);
  const { proof, publicInputs } = await backend.generateProof(solved, { verifierTarget: VERIFIER_TARGET });

  // The verifier side rebuilds public inputs from the statement; make sure both agree here,
  // where a mismatch is a bug in this package and not somebody else's invalid proof.
  const expected = publicInputsFor(statement);
  if (publicInputs.length !== PUBLIC_INPUT_COUNT || publicInputs.some((value, i) => BigInt(value) !== BigInt(expected[i]!))) {
    throw new Error('geofence prover produced unexpected public inputs');
  }
  return { circuit: GEOFENCE_CIRCUIT, vkHash: GEOFENCE_VK_HASH, proof };
}

/**
 * Checks a geofence proof against a statement the caller assembled from data it trusts.
 * Returns false for an invalid proof; never throws for one.
 */
export async function verifyGeofence(
  statement: GeofenceStatement,
  proof: Uint8Array,
  options?: { threads?: number },
): Promise<boolean> {
  let publicInputs: string[];
  try {
    publicInputs = publicInputsFor(statement);
  } catch {
    return false;
  }
  const api = await getBarretenberg(options);
  try {
    return await new UltraHonkVerifierBackend(api).verifyProof(
      { proof, publicInputs, verificationKey: GEOFENCE_VK },
      { verifierTarget: VERIFIER_TARGET },
    );
  } catch {
    return false;
  }
}

/** The identifier stored next to a proof (`proof_hash` in the Arkiv GeoProof entity). */
export function proofHash(proof: Uint8Array): Hex {
  return toHex(sha256(proof));
}
