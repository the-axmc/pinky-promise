/**
 * Where episode logs are kept: 0G Storage, addressed by the Merkle root of the bytes.
 *
 * Two implementations of one interface:
 *   ZgEpisodeStore     uploads to 0G Storage through the official SDK and downloads by root;
 *   LocalEpisodeStore  keeps the same bytes in a directory, for development without 0G tokens.
 *
 * Both compute the root with the 0G SDK's own Merkle tree, so a root produced locally is the
 * root 0G would assign to those bytes. The local store is selected by configuration only; it is
 * never a fallback for a failed upload (a failed upload leaves the checkpoint PENDING).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import type { Hex } from '@pinky/protocol';
import { JsonRpcProvider, Wallet } from 'ethers';

export type StoredEpisode = { root: Hex; txHash?: Hex };

export interface EpisodeStore {
  readonly kind: '0g' | 'local';
  /** Stores the bytes and resolves once they are retrievable by their root. */
  put(bytes: Uint8Array): Promise<StoredEpisode>;
  get(root: Hex): Promise<Uint8Array>;
}

/** The 0G Storage Merkle root of some bytes, computed locally. */
export async function zgMerkleRoot(bytes: Uint8Array): Promise<Hex> {
  const [tree, error] = await new MemData(bytes).merkleTree();
  const root = tree?.rootHash();
  if (error || !root) throw new Error(`could not compute the 0G Merkle root: ${error?.message ?? 'no root'}`);
  return root.toLowerCase() as Hex;
}

export class LocalEpisodeStore implements EpisodeStore {
  readonly kind = 'local' as const;
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  async put(bytes: Uint8Array): Promise<StoredEpisode> {
    const root = await zgMerkleRoot(bytes);
    writeFileSync(join(this.#directory, `${root}.bin`), bytes);
    return { root };
  }

  async get(root: Hex): Promise<Uint8Array> {
    if (!/^0x[0-9a-f]{64}$/.test(root)) throw new Error('not a 32-byte root hash');
    try {
      return new Uint8Array(readFileSync(join(this.#directory, `${root}.bin`)));
    } catch {
      throw new Error(`episode ${root} is not in the local store`);
    }
  }
}

export type ZgStorageConfig = {
  /** EVM RPC of the 0G chain, e.g. https://evmrpc-testnet.0g.ai */
  rpcUrl: string;
  /** Storage indexer, e.g. https://indexer-storage-testnet-turbo.0g.ai */
  indexerUrl: string;
  /** Pays the storage fee. Needs a little 0G on that chain. */
  privateKey: Hex;
};

export class ZgEpisodeStore implements EpisodeStore {
  readonly kind = '0g' as const;
  readonly #config: ZgStorageConfig;
  readonly #indexer: Indexer;
  readonly #signer: Wallet;

  constructor(config: ZgStorageConfig) {
    this.#config = config;
    this.#indexer = new Indexer(config.indexerUrl);
    this.#signer = new Wallet(config.privateKey, new JsonRpcProvider(config.rpcUrl));
  }

  get address(): string {
    return this.#signer.address;
  }

  async put(bytes: Uint8Array): Promise<StoredEpisode> {
    const expected = await zgMerkleRoot(bytes);
    const [result, error] = await this.#indexer.upload(
      new MemData(bytes),
      this.#config.rpcUrl,
      this.#signer as never,
    );
    if (error) throw new Error(`0G Storage upload failed: ${error.message}`);
    const root = ('rootHash' in result ? result.rootHash : result.rootHashes[0])?.toLowerCase();
    const txHash = 'txHash' in result ? result.txHash : result.txHashes[0];
    if (root !== expected) throw new Error(`0G Storage returned root ${root}, expected ${expected}`);
    return { root: expected, ...(txHash ? { txHash: txHash as Hex } : {}) };
  }

  async get(root: Hex): Promise<Uint8Array> {
    const [blob, error] = await this.#indexer.downloadToBlob(root, { proof: true });
    if (error) throw new Error(`0G Storage download failed: ${error.message}`);
    return new Uint8Array(await blob.arrayBuffer());
  }
}
