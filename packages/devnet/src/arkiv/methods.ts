/**
 * The three `arkiv_*` read methods (docs.arkiv.network/json-rpc/querying-data), answered from
 * the devnet's entity replica:
 *
 *   arkiv_query(query, { select?, limit?, offset? })  -> { data, blockNumber, count? }
 *   arkiv_getEntity(key)                              -> entity | null
 *   arkiv_getBlockTiming()                            -> { current_block, current_block_time, duration }
 */
import type { Hex } from 'viem';
import { MAX_LIMIT, type StoredEntity, jsonValueOf } from './model';
import { INVALID_PARAMS, RpcError } from './query/errors';
import { matches, sortEntities } from './query/evaluate';
import { parseQuery } from './query/parser';
import type { ChainRpc, EntityStore } from './store';

type Select = {
  key?: boolean;
  owner?: boolean;
  creator?: boolean;
  createdAt?: boolean;
  updatedAt?: boolean;
  expiresAt?: boolean;
  creationFlags?: boolean;
  attributeSchema?: boolean;
  attributes?: boolean | Record<string, boolean>;
  count?: boolean;
};

const ENTITY_FIELDS = [
  'key',
  'owner',
  'creator',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'creationFlags',
  'attributeSchema',
  'attributes',
] as const;

const quantity = (value: bigint) => `0x${value.toString(16)}`;

/** One entity as JSON, holding only the selected fields, in the node's field order. */
function renderEntity(entity: StoredEntity, select: Select): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (select.key) out.key = entity.key;
  if (select.owner) out.owner = entity.owner;
  if (select.creator) out.creator = entity.creator;
  if (select.createdAt) out.createdAt = quantity(entity.createdAt);
  if (select.updatedAt) out.updatedAt = quantity(entity.updatedAt);
  if (select.expiresAt) out.expiresAt = quantity(entity.expiresAt);
  if (select.creationFlags) {
    out.creationFlags = {
      readonly: (entity.creationFlags & 0x01) !== 0,
      permissionlessExtension: (entity.creationFlags & 0x02) !== 0,
      raw: entity.creationFlags,
    };
  }

  // Attributes come back in the order the engine keeps them: ascending by name bytes.
  const sorted = [...entity.attributes.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (select.attributeSchema) {
    out.attributeSchema = sorted.map(({ name, type, indexed }) => ({ name, type, indexed }));
  }
  if (select.attributes) {
    const wanted = select.attributes;
    out.attributes = sorted
      .filter((attribute) => wanted === true || wanted[attribute.name] === true)
      .map((attribute) => ({ name: attribute.name, type: attribute.type, value: jsonValueOf(attribute) }));
  }
  return out;
}

function parseQuantity(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  let parsed: number;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) parsed = Number(BigInt(value));
  else throw new RpcError(INVALID_PARAMS, `${field} must be a hex quantity`);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new RpcError(INVALID_PARAMS, `${field} must be a hex quantity`);
  return parsed;
}

function parseSelect(value: unknown): Select {
  // Left out entirely, the select is { key: true }. Given, exactly what it says.
  if (value === undefined || value === null) return { key: true };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(INVALID_PARAMS, 'select must be an object of fields');
  }
  const select = value as Record<string, unknown>;
  for (const [field, wanted] of Object.entries(select)) {
    if (field === 'attributes') {
      const isMap = typeof wanted === 'object' && wanted !== null && !Array.isArray(wanted);
      if (typeof wanted !== 'boolean' && !isMap) {
        throw new RpcError(INVALID_PARAMS, 'select.attributes must be a boolean or an object of names');
      }
    } else if (typeof wanted !== 'boolean') {
      throw new RpcError(INVALID_PARAMS, `select.${field} must be a boolean`);
    }
  }
  return select as Select;
}

export async function arkivQuery(store: EntityStore, params: unknown[]): Promise<unknown> {
  const [query, options] = params;
  if (typeof query !== 'string')
    throw new RpcError(INVALID_PARAMS, 'the first parameter is the query string');
  if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) {
    throw new RpcError(INVALID_PARAMS, 'the second parameter is an options object');
  }
  const {
    select: rawSelect,
    limit: rawLimit,
    offset: rawOffset,
  } = (options ?? {}) as Record<string, unknown>;

  const select = parseSelect(rawSelect);
  const limit = parseQuantity(rawLimit, 'limit') ?? MAX_LIMIT;
  if (limit < 1) throw new RpcError(INVALID_PARAMS, 'limit must be at least 1');
  if (limit > MAX_LIMIT) {
    throw new RpcError(INVALID_PARAMS, `limit ${limit} exceeds the node maximum of ${MAX_LIMIT}`);
  }
  const offset = parseQuantity(rawOffset, 'offset') ?? 0;

  const parsed = parseQuery(query);
  const head = await store.sync();
  const matching = store.liveEntities(head.blockNumber).filter((entity) => matches(parsed.where, entity));

  const result: Record<string, unknown> = { data: [], blockNumber: quantity(head.blockNumber) };
  // With count as the only selected field there are no rows to return.
  const wantsRows = ENTITY_FIELDS.some((field) => Boolean(select[field])) || !select.count;
  if (wantsRows) {
    result.data = sortEntities(matching, parsed.orderBy)
      .slice(offset, offset + limit)
      .map((entity) => renderEntity(entity, select));
  }
  if (select.count) result.count = quantity(BigInt(matching.length));
  return result;
}

export async function arkivGetEntity(store: EntityStore, params: unknown[]): Promise<unknown> {
  const [key] = params;
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new RpcError(INVALID_PARAMS, 'the parameter is an entity key: 0x followed by 64 hex digits');
  }
  const head = await store.sync();
  const entity = store.getLive(key as Hex, head.blockNumber);
  if (entity === undefined) return null;
  // Every field except attributeSchema.
  return renderEntity(entity, {
    key: true,
    owner: true,
    creator: true,
    createdAt: true,
    updatedAt: true,
    expiresAt: true,
    creationFlags: true,
    attributes: true,
  });
}

export async function arkivGetBlockTiming(rpc: ChainRpc): Promise<unknown> {
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  const number = BigInt(block.number);
  const timestamp = Number(BigInt(block.timestamp));
  let duration = 0;
  if (number > 0n) {
    const previous = await rpc('eth_getBlockByNumber', [`0x${(number - 1n).toString(16)}`, false]);
    duration = timestamp - Number(BigInt(previous.timestamp));
  }
  return { current_block: Number(number), current_block_time: timestamp, duration };
}
