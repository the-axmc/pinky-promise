/**
 * The devnet's replica of entity state, rebuilt purely from the engine's logs.
 *
 * Nothing is persisted: `sync()` reads the logs between the last block it saw and the chain
 * head and applies them in order, so a freshly started proxy catches up from block 0 and a chain
 * that was reset or reverted is detected (by block hash) and replayed from scratch.
 *
 * Natural expiry has no event. An entity is live while `expiresAt > currentBlock`, so readers
 * pass the block they are reading at and expired entities simply stop being returned.
 */
import { type Hex, decodeEventLog, hexToBytes } from 'viem';
import {
  ARKIV_ENGINE_ADDRESS,
  ENGINE_EVENTS_ABI,
  INDEXED_FLAG,
  type StoredEntity,
  TOMBSTONE_TYPE_ID,
  TYPE_TAGS,
  nameFromIdent32,
} from './model';

/** A JSON-RPC call against the underlying chain (anvil). Throws on an error response. */
export type ChainRpc = (method: string, params?: unknown[]) => Promise<any>;

export type Head = { blockNumber: bigint; blockHash: Hex; timestamp: bigint };

type RawLog = { topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex };

export class EntityStore {
  private readonly entities = new Map<Hex, StoredEntity>();
  private syncedBlock = -1n;
  private created = 0;
  private syncedHash: Hex | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly rpc: ChainRpc) {}

  /** Brings the replica up to the chain head. Calls are serialized. */
  sync(): Promise<Head> {
    const run = this.queue.then(() => this.syncOnce());
    // Keep the queue alive after a failed sync; the caller still sees the rejection.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Every entity that is live at `blockNumber`. */
  liveEntities(blockNumber: bigint): StoredEntity[] {
    const live: StoredEntity[] = [];
    for (const entity of this.entities.values()) {
      if (entity.expiresAt > blockNumber) live.push(entity);
    }
    return live;
  }

  getLive(key: Hex, blockNumber: bigint): StoredEntity | undefined {
    const entity = this.entities.get(key.toLowerCase() as Hex);
    return entity !== undefined && entity.expiresAt > blockNumber ? entity : undefined;
  }

  private async syncOnce(): Promise<Head> {
    const block = await this.rpc('eth_getBlockByNumber', ['latest', false]);
    const head: Head = {
      blockNumber: BigInt(block.number),
      blockHash: block.hash,
      timestamp: BigInt(block.timestamp),
    };

    if (this.syncedBlock >= 0n) {
      // If the block we stopped at is no longer on the chain (anvil_reset, evm_revert, a fresh
      // chain behind the same port), everything we derived from it is void.
      let stillThere = head.blockNumber >= this.syncedBlock;
      if (stillThere && head.blockNumber !== this.syncedBlock) {
        const previous = await this.rpc('eth_getBlockByNumber', [`0x${this.syncedBlock.toString(16)}`, false]);
        stillThere = previous?.hash === this.syncedHash;
      } else if (stillThere) {
        stillThere = head.blockHash === this.syncedHash;
      }
      if (!stillThere) {
        this.entities.clear();
        this.created = 0;
        this.syncedBlock = -1n;
        this.syncedHash = undefined;
      }
    }

    if (head.blockNumber > this.syncedBlock) {
      const logs: RawLog[] = await this.rpc('eth_getLogs', [
        {
          address: ARKIV_ENGINE_ADDRESS,
          fromBlock: `0x${(this.syncedBlock + 1n).toString(16)}`,
          toBlock: `0x${head.blockNumber.toString(16)}`,
        },
      ]);
      logs.sort((a, b) => {
        const blocks = BigInt(a.blockNumber) - BigInt(b.blockNumber);
        if (blocks !== 0n) return blocks < 0n ? -1 : 1;
        return Number(BigInt(a.logIndex) - BigInt(b.logIndex));
      });
      for (const log of logs) this.apply(log);
      this.syncedBlock = head.blockNumber;
      this.syncedHash = head.blockHash;
    }

    // Expired entities can never come back (an extension needs a live entity), so drop them.
    for (const [key, entity] of this.entities) {
      if (entity.expiresAt <= head.blockNumber) this.entities.delete(key);
    }
    return head;
  }

  private apply(log: RawLog): void {
    let event;
    try {
      event = decodeEventLog({ abi: ENGINE_EVENTS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data });
    } catch {
      return; // not one of the engine's events
    }
    const blockNumber = BigInt(log.blockNumber);
    const key = event.args.entityKey.toLowerCase() as Hex;

    switch (event.eventName) {
      case 'EntityCreated': {
        const owner = event.args.owner.toLowerCase() as Hex;
        this.entities.set(key, {
          key,
          owner,
          creator: owner,
          createdAt: blockNumber,
          updatedAt: blockNumber,
          expiresAt: event.args.expiresAt,
          creationFlags: event.args.creationFlags,
          attributes: new Map(),
          sequence: this.created++,
        });
        return;
      }
      case 'DevAttributes': {
        const entity = this.entities.get(key);
        if (entity === undefined) return;
        for (const attribute of event.args.attributes) {
          const name = nameFromIdent32(attribute.name);
          if (attribute.typeId === TOMBSTONE_TYPE_ID) {
            entity.attributes.delete(name);
            continue;
          }
          const type = TYPE_TAGS[(attribute.typeId & ~INDEXED_FLAG) as keyof typeof TYPE_TAGS];
          if (type === undefined) continue; // the engine rejects unknown types; nothing to store
          entity.attributes.set(name, {
            name,
            type,
            indexed: (attribute.typeId & INDEXED_FLAG) !== 0,
            raw: hexToBytes(attribute.value),
          });
        }
        return;
      }
      case 'EntityPatched': {
        const entity = this.entities.get(key);
        if (entity !== undefined) entity.updatedAt = blockNumber;
        return;
      }
      case 'ExpiryExtended': {
        const entity = this.entities.get(key);
        if (entity !== undefined) entity.expiresAt = event.args.expiresAt;
        return;
      }
      case 'OwnershipTransferred': {
        const entity = this.entities.get(key);
        if (entity !== undefined) entity.owner = event.args.newOwner.toLowerCase() as Hex;
        return;
      }
      case 'EntityDeleted':
        this.entities.delete(key);
        return;
    }
  }
}

