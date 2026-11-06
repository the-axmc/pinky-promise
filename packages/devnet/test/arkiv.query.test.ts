/**
 * Acceptance tests for queries against the local Arkiv devnet, driven through the unmodified
 * `@arkiv-network/sdk` query builder (and its raw-string escape hatch).
 */
import { ExpirationTime, SchemaMismatchError, createPublicClient, createWalletClient } from '@arkiv-network/sdk';
import {
  InvalidPredicateError,
  QueryError,
  and,
  asc,
  between,
  desc,
  eq,
  exists,
  gt,
  gte,
  hasType,
  lt,
  lte,
  or,
  startsWith,
} from '@arkiv-network/sdk/query';
import { addr, bool, bytes, dec, defineSchema, i32, key, str, u64, u256 } from '@arkiv-network/sdk/schema';
import { type Hex, getAddress, http, stringToBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ArkivDevnet, startArkivDevnet } from '../src/arkiv/index';

const Items = defineSchema('test.items', {
  sku: str().indexed(),
  category: str().indexed(),
  price: dec().indexed(),
  stock: i32().indexed(),
  listedAt: u64().indexed(),
  weight: u256().indexed(),
  active: bool().indexed(),
  seller: addr().indexed(),
  parent: key().indexed().optional(),
  rank: i32().optional(), // stored but not indexed, and only on some entities
  title: str(), // stored but not indexed
  payload: bytes(),
});

/** Same column name as Items, different tag: a query through one must not see the other. */
const Other = defineSchema('test.other', { category: str().indexed(), title: str() });
/** No name, so no tag. */
const Untagged = defineSchema({ category: str().indexed(), title: str() });

let devnet: ArkivDevnet;
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const parentKey = `0x${'11'.repeat(32)}` as Hex;
const HUGE = 2n ** 100n;

type Seed = {
  sku: string;
  category: string;
  price: string;
  stock: number;
  listedAt: bigint;
  weight: bigint;
  active: boolean;
  by: typeof alice;
  parent?: boolean;
  rank?: number;
  title: string;
};

const SEED: Seed[] = [
  { sku: 'A-1', category: 'tools', price: '9.99', stock: 10, listedAt: 1000n, weight: 5n, active: true, by: alice, rank: 3, title: 'Hammer' },
  { sku: 'A-2', category: 'tools', price: '24.5', stock: 0, listedAt: 2000n, weight: HUGE, active: true, by: alice, parent: true, title: 'Drill' },
  { sku: 'A-3', category: 'tools', price: '24.5', stock: -5, listedAt: 3000n, weight: 7n, active: false, by: alice, rank: 1, title: 'Saw' },
  { sku: 'B-1', category: 'toys', price: '3', stock: 100, listedAt: 4000n, weight: 1n, active: true, by: alice, parent: true, rank: 2, title: 'Ball' },
  { sku: 'B-2', category: 'toys', price: '15.25', stock: 7, listedAt: 5000n, weight: 9n, active: false, by: alice, title: 'Kite' },
  { sku: 'C-1', category: 'books', price: '12', stock: 3, listedAt: 6000n, weight: 300n, active: true, by: alice, title: 'Novel' },
  { sku: 'C-2', category: 'books', price: '0.5', stock: 1, listedAt: 7000n, weight: 4n, active: true, by: bob, rank: 5, title: 'Zine' },
  { sku: 'D-1', category: 'garden', price: '-1.5', stock: 2, listedAt: 8000n, weight: 8n, active: false, by: bob, title: 'Hose' },
];

const reader = () => createPublicClient({ chain: devnet.chain, transport: http(), cacheTime: 0 });
const walletOf = (account: typeof alice) =>
  createWalletClient({ chain: devnet.chain, transport: http(), account, cacheTime: 0 });

/** The SKUs a filter matches through the Items schema, sorted for comparison. */
async function skus(...filters: Parameters<ReturnType<ReturnType<typeof reader>['select']>['where']>): Promise<string[]> {
  const page = await reader()
    .select({ sku: true })
    .from(Items)
    .where(...(filters as []))
    .fetch();
  return page.entities.map((row) => row.sku.value).sort();
}

beforeAll(async () => {
  devnet = await startArkivDevnet({ blockTime: 0 });
  await devnet.fund(alice.address);
  await devnet.fund(bob.address);
  const expiration = ExpirationTime.fromBlocks(10_000);

  for (const seed of SEED) {
    await walletOf(seed.by).createEntity(
      Items,
      {
        sku: seed.sku,
        category: seed.category,
        price: dec(seed.price),
        stock: seed.stock,
        listedAt: u64(seed.listedAt),
        weight: seed.weight,
        active: seed.active,
        seller: addr(seed.by.address),
        ...(seed.parent && { parent: key(parentKey) }),
        ...(seed.rank !== undefined && { rank: seed.rank }),
        title: seed.title,
        payload: stringToBytes(`payload of ${seed.sku}`),
      },
      { expiration },
    );
  }
  await walletOf(alice).createEntity(Other, { category: 'tools', title: 'not an item' }, { expiration });
  await walletOf(alice).createEntity(Untagged, { category: 'tools', title: 'no tag at all' }, { expiration });
}, 60_000);

afterAll(async () => {
  await devnet?.stop();
});

describe('conditions', () => {
  it('matches equality on every indexable type', async () => {
    expect(await skus(eq('category', 'tools'))).toEqual(['A-1', 'A-2', 'A-3']);
    expect(await skus(eq('active', false))).toEqual(['A-3', 'B-2', 'D-1']);
    expect(await skus(eq('stock', -5))).toEqual(['A-3']);
    expect(await skus(eq('listedAt', u64(4000n)))).toEqual(['B-1']);
    expect(await skus(eq('weight', HUGE))).toEqual(['A-2']);
    expect(await skus(eq('price', dec('24.5')))).toEqual(['A-2', 'A-3']);
    expect(await skus(eq('price', dec('24.50')))).toEqual(['A-2', 'A-3']); // same value, other spelling
    expect(await skus(eq('seller', addr(bob.address)))).toEqual(['C-2', 'D-1']);
    expect(await skus(eq('parent', key(parentKey)))).toEqual(['A-2', 'B-1']);
  });

  it('compares numbers by value, including negatives and values above 2^64', async () => {
    expect(await skus(gt('price', dec('12')))).toEqual(['A-2', 'A-3', 'B-2']);
    expect(await skus(gte('price', dec('12')))).toEqual(['A-2', 'A-3', 'B-2', 'C-1']);
    expect(await skus(lt('price', dec('1')))).toEqual(['C-2', 'D-1']);
    expect(await skus(lt('price', dec('0')))).toEqual(['D-1']);
    expect(await skus(lte('stock', 0))).toEqual(['A-2', 'A-3']);
    expect(await skus(gt('listedAt', u64(5000n)))).toEqual(['C-1', 'C-2', 'D-1']);
    expect(await skus(gt('weight', 2n ** 64n))).toEqual(['A-2']);
    expect(await skus(lt('weight', 5n))).toEqual(['B-1', 'C-2']);
  });

  it('compares strings byte by byte and orders false before true', async () => {
    expect(await skus(gt('sku', 'B'))).toEqual(['B-1', 'B-2', 'C-1', 'C-2', 'D-1']);
    expect(await skus(lte('sku', 'A-2'))).toEqual(['A-1', 'A-2']);
    expect(await skus(gt('active', false))).toEqual(['A-1', 'A-2', 'B-1', 'C-1', 'C-2']);
    expect(await skus(lt('active', true))).toEqual(['A-3', 'B-2', 'D-1']);
  });

  it('treats BETWEEN as inclusive at both ends', async () => {
    expect(await skus(between('price', dec('3'), dec('12')))).toEqual(['A-1', 'B-1', 'C-1']);
    expect(await skus(between('stock', -5, 1))).toEqual(['A-2', 'A-3', 'C-2']);
    expect(await skus(between('price', dec('12'), dec('3')))).toEqual([]); // low above high
  });

  it('matches string prefixes', async () => {
    expect(await skus(startsWith('sku', 'A-'))).toEqual(['A-1', 'A-2', 'A-3']);
    expect(await skus(startsWith('category', 'to'))).toEqual(['A-1', 'A-2', 'A-3', 'B-1', 'B-2']);
    expect(await skus(startsWith('category', 'tools!'))).toEqual([]);
  });

  it('finds entities that have an optional indexed attribute', async () => {
    expect(await skus(exists('parent'))).toEqual(['A-2', 'B-1']);
  });

  it('combines conditions with AND, OR and nesting', async () => {
    expect(await skus(eq('category', 'tools'), eq('active', true))).toEqual(['A-1', 'A-2']); // where(a, b) is AND
    expect(await skus(or(eq('category', 'books'), and(eq('category', 'tools'), eq('active', false))))).toEqual([
      'A-3',
      'C-1',
      'C-2',
    ]);
    expect(await skus(and(or(eq('category', 'toys'), eq('category', 'garden')), gt('price', dec('0'))))).toEqual([
      'B-1',
      'B-2',
    ]);
    expect(await skus(or(lt('price', dec('0')), gt('price', dec('20'))), eq('active', false))).toEqual(['A-3', 'D-1']);
  });

  it('asserts the type: a value of another type never matches', async () => {
    const client = reader();
    // Without a schema nothing stops us comparing a dec attribute against an i32.
    const wrongType = await client.select({ $key: true }).where(eq('category', 'tools'), eq('price', 24)).fetch();
    expect(wrongType.entities).toEqual([]);
    const tagged = await client.count().where(eq('category', 'tools'), hasType('price', 'dec')).fetch();
    expect(tagged).toBe(3n);
    expect(await client.count().where(eq('category', 'tools'), hasType('price', 'i32')).fetch()).toBe(0n);
  });
});

describe('what a condition can see', () => {
  it('only sees indexed attributes', async () => {
    const client = reader();
    // title and rank are stored without an index, so conditions on them match nothing.
    expect((await client.select({ $key: true }).where(eq('title', 'Hammer')).fetch()).entities).toEqual([]);
    expect(await client.count().where(eq('category', 'tools'), exists('title')).fetch()).toBe(0n);
    expect(await client.count().where(eq('category', 'tools'), hasType('rank', 'i32')).fetch()).toBe(0n);
    expect(await client.count().where(eq('category', 'tools'), exists('sku')).fetch()).toBe(3n);
  });

  it('is stopped by the SDK when a schema says the column is not indexed', async () => {
    const query = reader()
      .select({ sku: true })
      .from(Items)
      // @ts-expect-error title is not indexed, which the SDK also rejects at compile time
      .where(eq('title', 'Hammer'));
    await expect(query.fetch()).rejects.toBeInstanceOf(InvalidPredicateError);
  });

  it('keeps schemas apart by their tag', async () => {
    const client = reader();
    expect(await client.count().from(Items).fetch()).toBe(8n);
    expect(await client.count().from(Other).fetch()).toBe(1n);
    expect(await client.count().from(Items).where(eq('category', 'tools')).fetch()).toBe(3n);

    const other = await client.select({ title: true }).from(Other).where(eq('category', 'tools')).fetch();
    expect(other.entities.map((row) => row.title.value)).toEqual(['not an item']);

    // Without a schema the same filter sees all three kinds: tagged, other tag, and untagged.
    expect(await client.count().where(eq('category', 'tools')).fetch()).toBe(5n);
  });

  it('filters by owner and by creator', async () => {
    const client = reader();
    const fromBob = await client.select({ sku: true }).from(Items).createdBy(bob.address).fetch();
    expect(fromBob.entities.map((row) => row.sku.value).sort()).toEqual(['C-2', 'D-1']);
    expect(await client.count().from(Items).ownedBy(alice.address).fetch()).toBe(6n);
    expect(await client.count().from(Items).ownedBy(alice.address).where(eq('category', 'books')).fetch()).toBe(1n);
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(await client.count().from(Items).ownedBy(stranger.address).fetch()).toBe(0n);
  });
});

describe('sorting and paging', () => {
  it('sorts all matches, ascending or descending, on any sortable type', async () => {
    const client = reader();
    const byPrice = await client.select({ sku: true, price: true }).from(Items).orderBy(desc('price')).fetch();
    expect(byPrice.entities.map((row) => row.price.value)).toEqual(['24.5', '24.5', '15.25', '12', '9.99', '3', '0.5', '-1.5']);

    const byListing = await client.select({ sku: true }).from(Items).orderBy(asc('listedAt')).fetch();
    expect(byListing.entities.map((row) => row.sku.value)).toEqual(SEED.map((seed) => seed.sku));

    const bySku = await client.select({ sku: true }).from(Items).orderBy(desc('sku')).fetch();
    expect(bySku.entities.map((row) => row.sku.value)).toEqual(SEED.map((seed) => seed.sku).reverse());

    const byWeight = await client.select({ sku: true }).from(Items).orderBy(desc('weight')).limit(2).fetch();
    expect(byWeight.entities.map((row) => row.sku.value)).toEqual(['A-2', 'C-1']);

    const keys = await client.select({ $key: true }).from(Items).orderBy(desc('$key')).fetch();
    const sorted = keys.entities.map((row) => row.$key);
    expect(sorted).toEqual([...sorted].sort().reverse());
  });

  it('sorts on a non-indexed attribute, placing entities without it below every value', async () => {
    const client = reader();
    const ascending = await client.select({ sku: true, rank: true }).from(Items).orderBy(asc('rank')).fetch();
    expect(ascending.entities.map((row) => row.rank?.value)).toEqual([undefined, undefined, undefined, undefined, 1, 2, 3, 5]);

    const descending = await client.select({ sku: true, rank: true }).from(Items).orderBy(desc('rank')).fetch();
    expect(descending.entities.map((row) => row.rank?.value)).toEqual([5, 3, 2, 1, undefined, undefined, undefined, undefined]);
    expect(descending.entities.slice(0, 4).map((row) => row.sku.value)).toEqual(['C-2', 'A-1', 'B-1', 'A-3']);
  });

  it('pages with limit and offset without repeating or missing a row', async () => {
    const client = reader();
    const page = (offset: number) =>
      client.select({ $key: true, sku: true }).from(Items).orderBy(asc('$key')).limit(3).offset(offset).fetch();
    const pages = [await page(0), await page(3), await page(6), await page(9)];
    expect(pages.map((p) => p.entities.length)).toEqual([3, 3, 2, 0]);
    const seen = pages.flatMap((p) => p.entities.map((row) => row.sku.value));
    expect(seen.sort()).toEqual(SEED.map((seed) => seed.sku));
  });

  it('pages by key, the way the docs recommend for reading every match once', async () => {
    const client = reader();
    const seen: string[] = [];
    let last: Hex | undefined;
    for (;;) {
      const builder = client.select({ $key: true, sku: true }).from(Items).orderBy(asc('$key')).limit(3);
      const next = await (last === undefined ? builder : builder.where(gt('$key', key(last)))).fetch();
      if (next.entities.length === 0) break;
      seen.push(...next.entities.map((row) => row.sku.value));
      last = next.entities.at(-1)!.$key;
    }
    expect(seen.sort()).toEqual(SEED.map((seed) => seed.sku));
  });

  it('counts every match, with or without rows', async () => {
    const client = reader();
    expect(await client.count().from(Items).where(eq('active', true)).fetch()).toBe(5n);
    const page = await client.select({ sku: true }).from(Items).where(eq('category', 'tools')).withCount().limit(2).fetch();
    expect(page.entities).toHaveLength(2);
    expect(page.count).toBe(3n);
    expect(page.blockNumber).toBe(await devnet.blockNumber());
  });
});

describe('selection', () => {
  it('returns only the selected fields', async () => {
    const client = reader();
    const page = await client.select({ title: true }).from(Items).where(eq('sku', 'A-1')).fetch();
    expect(Object.keys(page.entities[0]!)).toEqual(['title']);
    expect(page.entities[0]!.title.value).toBe('Hammer');

    const system = await client.select({ $owner: true, $creator: true, $expiresAt: true }).from(Items).where(eq('sku', 'C-2')).fetch();
    expect(system.entities[0]).toMatchObject({ $owner: getAddress(bob.address), $creator: getAddress(bob.address) });
    expect(typeof system.entities[0]!.$expiresAt).toBe('bigint');
  });

  it('returns every attribute, typed, as $attributes', async () => {
    const client = reader();
    const untyped = await client.select({ $attributes: true }).where(eq('sku', 'A-2')).fetch();
    const attributes = untyped.entities[0]!.$attributes;
    expect(attributes['arkiv.schema']).toEqual({ type: 'str', value: 'test.items' });
    expect(attributes.price).toEqual({ type: 'dec', value: '24.5' });
    expect(attributes.stock).toEqual({ type: 'i32', value: 0 });
    expect(attributes.listedAt).toEqual({ type: 'u64', value: 2000n });
    expect(attributes.weight).toEqual({ type: 'u256', value: HUGE });
    expect(attributes.active).toEqual({ type: 'bool', value: true });
    expect(attributes.seller).toEqual({ type: 'addr', value: getAddress(alice.address) });
    expect(attributes.parent).toEqual({ type: 'key', value: parentKey });
    expect(attributes.rank).toBeUndefined();

    // Through a named schema the tag is how the query finds entities, not one of their attributes.
    const typed = await client.select({ $attributes: true }).from(Items).where(eq('sku', 'A-2')).fetch();
    expect(typed.entities[0]!.$attributes['arkiv.schema']).toBeUndefined();
    expect(typed.entities[0]!.$attributes.title).toEqual({ type: 'str', value: 'Drill' });
  });

  it('describes attributes without their values as $attributeSchema', async () => {
    const client = reader();
    const page = await client.select({ $attributeSchema: true }).where(eq('sku', 'A-1')).fetch();
    expect(page.entities[0]!.$attributeSchema).toEqual({
      'arkiv.schema': { type: 'str', indexed: true },
      active: { type: 'bool', indexed: true },
      category: { type: 'str', indexed: true },
      listedAt: { type: 'u64', indexed: true },
      payload: { type: 'bytes', indexed: false },
      price: { type: 'dec', indexed: true },
      rank: { type: 'i32', indexed: false },
      seller: { type: 'addr', indexed: true },
      sku: { type: 'str', indexed: true },
      stock: { type: 'i32', indexed: true },
      title: { type: 'str', indexed: false },
      weight: { type: 'u256', indexed: true },
    });
  });

  it('skips, or on request rejects, entities that carry the tag but do not fit the schema', async () => {
    const Loose = defineSchema('test.strict', { name: str().indexed() });
    const Strict = defineSchema('test.strict', { name: str().indexed(), size: i32() });
    const expiration = ExpirationTime.fromBlocks(1000);
    await walletOf(alice).createEntity(Loose, { name: 'no size' }, { expiration });
    await walletOf(alice).createEntity(Strict, { name: 'sized', size: 4 }, { expiration });

    const client = reader();
    const page = await client.select({ name: true, size: true }).from(Strict).fetch();
    expect(page.entities.map((row) => row.name.value)).toEqual(['sized']);
    expect(page.skipped).toBe(1);

    await expect(
      client.select({ name: true, size: true }).from(Strict, { onMismatch: 'throw' }).fetch(),
    ).rejects.toBeInstanceOf(SchemaMismatchError);
  });
});

describe('raw query strings', () => {
  it('runs a hand-written query with ORDER BY', async () => {
    const page = await reader().query(
      "arkiv.schema = str('test.items') AND price BETWEEN dec(3) AND dec(12) ORDER BY price:dec DESC",
      { select: { sku: true, price: true } },
    );
    expect(page.entities.map((row) => row.sku?.value)).toEqual(['C-1', 'A-1', 'B-1']);
  });

  it('accepts lowercase keywords, comments and names with dots', async () => {
    const page = await reader().query(
      "arkiv.schema = str('test.items') and (category = str('toys') or category = str('garden')) -- only these\n order by sku:str desc",
      { select: { sku: true }, count: true },
    );
    expect(page.entities.map((row) => row.sku?.value)).toEqual(['D-1', 'B-2', 'B-1']);
    expect(page.count).toBe(3n);
  });

  it('rejects malformed queries with the node error kinds the SDK understands', async () => {
    const client = reader();
    const rejection = async (query: string): Promise<QueryError> => {
      try {
        await client.query(query);
      } catch (error) {
        return error as QueryError;
      }
      throw new Error(`expected the node to reject: ${query}`);
    };

    const parse = await rejection("category = 'tools'");
    expect(parse).toBeInstanceOf(QueryError);
    expect(parse.kind).toBe('parse');
    expect(parse.code).toBe(-32001);
    expect(parse.data).toMatchObject({ position: 11 });

    const type = await rejection("category != str('tools')");
    expect(type.kind).toBe('type');
    expect(type.message).toContain('!= is not part of the query language');

    const mixed = await rejection('stock BETWEEN i32(1) AND u64(5)');
    expect(mixed.kind).toBe('type');

    const literal = await rejection('stock = i32(99999999999)');
    expect(literal.kind).toBe('literal');
    expect(literal.code).toBe(-32003);

    const unsortable = await rejection("category = str('tools') ORDER BY price");
    expect(unsortable.kind).toBe('type');
    expect(unsortable.message).toContain('ORDER BY names the one to sort it as');
  });
});
