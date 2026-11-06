/**
 * The verifier for the geofence circuit, on its own.
 *
 * Verifying needs only the verification key, so this module does not import the Noir runtime
 * or the circuit bytecode — which is what lets the buyer's browser check a proof without
 * loading the prover. Import it as `@pinky/zk/verify`.
 */
import { Barretenberg, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { type Hex, fromHex, sha256, toHex } from '@pinky/protocol';
import vkArtifact from '../artifacts/geofence.vk.json' with { type: 'json' };
import { VERIFIER_TARGET } from './constants';
import { type GeofenceStatement, publicInputsFor } from './inputs';

/** SHA-256 of the verification key: identifies the exact circuit a proof was made for. */
export const GEOFENCE_VK_HASH = vkArtifact.vkHash as Hex;
export const GEOFENCE_VK: Uint8Array = fromHex(vkArtifact.vk);

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
