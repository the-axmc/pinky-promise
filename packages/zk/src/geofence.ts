/**
 * Prover for the geofence circuit. Proving needs the circuit bytecode and the Noir runtime and
 * happens on the gateway (about two seconds natively). The verifier lives in verify.ts, which
 * is all a browser needs.
 */
import { UltraHonkBackend } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';
import { type Hex, ProtocolError } from '@pinky/protocol';
import circuitArtifact from '../artifacts/geofence.circuit.json' with { type: 'json' };
import { GEOFENCE_CIRCUIT, PUBLIC_INPUT_COUNT, VERIFIER_TARGET } from './constants';
import { type GeofenceStatement, type GeofenceWitness, circuitInputs, publicInputsFor } from './inputs';
import { GEOFENCE_VK_HASH, getBarretenberg } from './verify';

export type GeofenceProof = {
  circuit: typeof GEOFENCE_CIRCUIT;
  vkHash: Hex;
  /** The proof bytes (about 8.8 KB). Public inputs are not included: verifiers rebuild them. */
  proof: Uint8Array;
};

/**
 * Proves that the reading behind `statement.digest` was signed by `statement.publicKey` and
 * taken inside `statement.box`. Throws {@link ProtocolError} if that is not true — an
 * out-of-box position, a wrong salt or a foreign signature has no valid witness.
 */
export async function proveGeofence(
  statement: GeofenceStatement,
  witness: GeofenceWitness,
): Promise<GeofenceProof> {
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
  if (
    publicInputs.length !== PUBLIC_INPUT_COUNT ||
    publicInputs.some((value, i) => BigInt(value) !== BigInt(expected[i]!))
  ) {
    throw new Error('geofence prover produced unexpected public inputs');
  }
  return { circuit: GEOFENCE_CIRCUIT, vkHash: GEOFENCE_VK_HASH, proof };
}
