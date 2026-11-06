/** Name and version of the circuit; stored with every proof so a verifier picks the right key. */
export const GEOFENCE_CIRCUIT = 'geofence-v1';

/**
 * Barretenberg proving flavour. "evm" is UltraHonk with zero knowledge and a Keccak transcript:
 * the smallest proofs (about 8.8 KB here) and the one a Solidity verifier could also check.
 * Prover and verifier must agree on it, so it is fixed here rather than passed around.
 */
export const VERIFIER_TARGET = 'evm' as const;

/** digest (32) + public key x (32) + y (32) + four box bounds. */
export const PUBLIC_INPUT_COUNT = 100;
