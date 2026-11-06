/**
 * Unit tests for the devnet's query-language implementation, with no chain involved.
 *
 * Every "as on Rabdi" expectation below — error code, wording and position — was captured from
 * the real node (https://rpc.rabdi.db-chain.testnet.arkiv.network) by sending it the same query.
 * They are the reference this emulation is held to.
 */
import { type Hex, hexToBytes, stringToBytes, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { StoredAttribute, StoredEntity, TypeTag } from '../src/arkiv/model';
import { RpcError } from '../src/arkiv/query/errors';
import { matches, sortEntities } from '../src/arkiv/query/evaluate';
import { parseQuery } from '../src/arkiv/query/parser';

const word = (value: bigint) => hexToBytes(toHex(BigInt.asUintN(256, value), { size: 32 }));
const attr = (name: string, type: TypeTag, raw: Uint8Array, indexed = true): StoredAttribute => ({
  name,
  type,
  indexed,
  raw,
});

let created = 0;
function entity(attributes: StoredAttribute[], overrides: Partial<StoredEntity> = {}): StoredEntity {
  const sequence = created++;
  return {
    key: toHex(BigInt(1000 - sequence), { size: 32 }), // keys run opposite to creation order
    owner: `0x${'aa'.repeat(20)}`,
    creator: `0x${'aa'.repeat(20)}`,
    createdAt: 1n,
    updatedAt: 1n,
    expiresAt: 100n,
    creationFlags: 0,
    attributes: new Map(attributes.map((a) => [a.name, a])),
    sequence,
    ...overrides,
  };
}

const hashA = `0x${'a1'.repeat(32)}` as Hex;
const hashB = `0x${'b2'.repeat(32)}` as Hex;

const hammer = entity([
  attr('category', 'str', stringToBytes('tools')),
  attr('price', 'dec', word(9_990_000_000_000_000_000n)),
  attr('stock', 'i32', word(10n)),
  attr('active', 'bool', word(1n)),
  attr('manifest', 'bytes32', hexToBytes(hashA)),
  attr('title', 'str', stringToBytes('Hammer'), false),
  attr('rank', 'i32', word(3n), false),
]);
const saw = entity([
  attr('category', 'str', stringToBytes('tools')),
  attr('price', 'dec', word(24_500_000_000_000_000_000n)),
  attr('stock', 'i32', word(-5n)),
  attr('active', 'bool', word(0n)),
  attr('manifest', 'key', hexToBytes(hashB)),
  attr('title', 'str', stringToBytes('Saw'), false),
]);
const ball = entity(
  [
    attr('category', 'str', stringToBytes('toys')),
    attr('price', 'dec', word(3_000_000_000_000_000_000n)),
    attr('stock', 'i32', word(100n)),
    attr('active', 'bool', word(1n)),
    attr('a.b-c_d', 'str', stringToBytes("it's")),
    attr('order', 'i32', word(1n)),
    attr('rank', 'i32', word(1n), false),
  ],
  { owner: `0x${'bb'.repeat(20)}`, expiresAt: 500n },
);
const ALL = [hammer, saw, ball];

/** The entities a query matches, by position in ALL, in result order. */
function run(query: string): number[] {
  const parsed = parseQuery(query);
  return sortEntities(
    ALL.filter((e) => matches(parsed.where, e)),
    parsed.orderBy,
  ).map((e) => ALL.indexOf(e));
}

function rejection(query: string): { code: number; message: string; position: number | undefined } {
  try {
    parseQuery(query);
  } catch (error) {
    if (error instanceof RpcError) {
      return {
        code: error.code,
        message: error.message,
        position: (error.data as { position?: number } | undefined)?.position,
      };
    }
    throw error;
  }
  throw new Error(`expected the query to be rejected: ${query}`);
}

describe('conditions', () => {
  it('compares typed literals', () => {
    expect(run("category = str('tools')")).toEqual([0, 1]);
    expect(run('price > dec(9.99)')).toEqual([1]);
    expect(run('price >= dec(9.99)')).toEqual([0, 1]);
    expect(run('price < dec(9.990000000000000001)')).toEqual([0, 2]);
    expect(run('stock <= i32(-5)')).toEqual([1]);
    expect(run('active = true')).toEqual([0, 2]);
    expect(run('active = FALSE')).toEqual([1]);
    expect(run('stock BETWEEN i32(-5) AND i32(10)')).toEqual([0, 1]);
    expect(run('stock BETWEEN i32(10) AND i32(-5)')).toEqual([]);
    expect(run("category STARTSWITH str('to')")).toEqual([0, 1, 2]);
    expect(run("category STARTSWITH str('toy')")).toEqual([2]);
  });

  it('treats a bare number as an i32', () => {
    expect(run('stock = 10')).toEqual([0]);
    expect(run('stock = -5')).toEqual([1]);
    expect(run('price = 3')).toEqual([]); // price is a dec, so an i32 never matches
  });

  it('only sees indexed attributes', () => {
    expect(run("title = str('Hammer')")).toEqual([]);
    expect(run('EXISTS(title)')).toEqual([]);
    expect(run('TYPEOF(rank) = i32')).toEqual([]);
    expect(run('EXISTS(manifest)')).toEqual([0, 1]);
    expect(run('TYPEOF(stock) = i32')).toEqual([0, 1, 2]);
    expect(run('TYPEOF(stock) = u64')).toEqual([]);
  });

  it('compares key and bytes32 as one type, as on Rabdi', () => {
    // hammer stores manifest as bytes32, saw as key; either literal finds either.
    expect(run(`manifest = key(${hashA})`)).toEqual([0]);
    expect(run(`manifest = bytes32(${hashA})`)).toEqual([0]);
    expect(run(`manifest = bytes32(${hashB})`)).toEqual([1]);
    expect(run('TYPEOF(manifest) = key')).toEqual([0, 1]);
    expect(run('TYPEOF(manifest) = bytes32')).toEqual([0, 1]);
    expect(run('EXISTS(manifest) ORDER BY manifest:key DESC')).toEqual([1, 0]);
  });

  it('filters on the four entity fields', () => {
    expect(run(`$owner = addr(0x${'bb'.repeat(20)})`)).toEqual([2]);
    expect(run(`$creator = addr(0x${'aa'.repeat(20)})`)).toEqual([0, 1, 2]);
    expect(run('$expiresAt > u64(100)')).toEqual([2]);
    expect(run(`$key = key(${ball.key})`)).toEqual([2]);
    expect(run(`$key > key(${ball.key})`)).toEqual([0, 1]);
  });

  it('gives AND precedence over OR, and BETWEEN its own AND', () => {
    expect(run("category = str('toys') OR category = str('tools') AND active = false")).toEqual([1, 2]);
    expect(run("(category = str('toys') OR category = str('tools')) AND active = false")).toEqual([1]);
    expect(run('stock BETWEEN i32(0) AND i32(50) AND active = true')).toEqual([0]);
    expect(run("stock BETWEEN i32(0) AND i32(50) OR category = str('toys')")).toEqual([0, 2]);
  });

  it('reads names with dots, dashes and underscores, keywords in any case, and comments', () => {
    expect(run("a.b-c_d = str('it''s')")).toEqual([2]);
    expect(
      run("category = str('toys') and exists(a.b-c_d) -- the rest is a comment AND active = false"),
    ).toEqual([2]);
    expect(run("CATEGORY = str('tools')")).toEqual([]); // names are case-sensitive
    expect(run('order = i32(1)')).toEqual([2]); // "order" is only a keyword in ORDER BY
    expect(run('  \n stock\t=\n i32( 10 )  ')).toEqual([0]);
  });

  it('matches every entity with a lone *, as on Rabdi', () => {
    expect(run('*')).toEqual([0, 1, 2]);
    expect(run('* ORDER BY $expiresAt DESC')).toEqual([2, 0, 1]);
  });
});

describe('ordering', () => {
  it('uses creation order when there is no ORDER BY, and for ties', () => {
    expect(run('EXISTS(category)')).toEqual([0, 1, 2]);
    expect(run("category = str('tools') ORDER BY category:str DESC")).toEqual([0, 1]);
  });

  it('sorts ascending by default and reads non-indexed attributes', () => {
    expect(run('EXISTS(category) ORDER BY price:dec')).toEqual([2, 0, 1]);
    expect(run('EXISTS(category) ORDER BY price:dec ASC')).toEqual([2, 0, 1]);
    expect(run('EXISTS(category) ORDER BY price:dec desc')).toEqual([1, 0, 2]);
    expect(run('EXISTS(category) ORDER BY stock:i32')).toEqual([1, 0, 2]);
    // rank is not indexed and saw has none: below every value, so first ascending, last descending.
    expect(run('EXISTS(category) ORDER BY rank:i32 ASC')).toEqual([1, 2, 0]);
    expect(run('EXISTS(category) ORDER BY rank:i32 DESC')).toEqual([0, 2, 1]);
    // Sorted as another type, nobody has a value: creation order.
    expect(run('EXISTS(category) ORDER BY rank:u64 DESC')).toEqual([0, 1, 2]);
  });

  it('sorts on entity fields without naming their type', () => {
    expect(run('EXISTS(category) ORDER BY $key ASC')).toEqual([2, 1, 0]);
    expect(run('EXISTS(category) ORDER BY $key:key DESC')).toEqual([0, 1, 2]);
    expect(run('EXISTS(category) ORDER BY $owner DESC')).toEqual([2, 0, 1]);
  });
});

describe('rejections, as on Rabdi', () => {
  const S = "arkiv.schema = str('arkiv-chunking/manifest/v2')"; // 48 characters, as in the captures

  it('parse errors (-32001)', () => {
    expect(rejection('')).toEqual({
      code: -32001,
      message: 'empty query — write a predicate, or * to match every entity',
      position: 0,
    });
    expect(rejection('   -- only a comment')).toMatchObject({ code: -32001, position: 0 });
    expect(rejection('$owner = 0x0000000000000000000000000000000000000001')).toEqual({
      code: -32001,
      message: 'a hex literal must carry its type — write addr(0x…), key(0x…), bytes32(0x…) or u256(0x…)',
      position: 9,
    });
    expect(rejection(`${S} AND metadata = bytes(0x00)`)).toMatchObject({ code: -32001, position: 70 });
    expect(rejection(`${S} AND x = 4.5`)).toEqual({
      code: -32001,
      message: 'unexpected character',
      position: 58,
    });
    expect(rejection('ORDER BY $key ASC')).toEqual({
      code: -32001,
      message: 'expected a comparison operator (= < <= > >= BETWEEN STARTSWITH)',
      position: 6,
    });
    expect(rejection(`${S} AND`)).toEqual({ code: -32001, message: 'expected a predicate', position: 52 });
    expect(rejection(`${S} ORDER BY $key ASC junk`)).toEqual({
      code: -32001,
      message: 'unexpected input after ORDER BY — it ends the query, and sorts by one attribute',
      position: 67,
    });
    expect(rejection(`* AND ${S}`)).toEqual({
      code: -32001,
      message: '* matches every entity and cannot be combined with other predicates',
      position: 2,
    });
    expect(rejection('not = i32(1)')).toEqual({
      code: -32001,
      message: 'expected an attribute name',
      position: 4,
    });
    expect(rejection("arkiv.schema = str('abc'")).toEqual({
      code: -32001,
      message: "unterminated typed literal — expected a closing ')'",
      position: 15,
    });
    expect(rejection("category = 'tools'")).toMatchObject({ code: -32001, position: 11 });
    expect(rejection("(category = str('tools')")).toMatchObject({ code: -32001 });
    expect(rejection("category = str('tools') category = str('toys')")).toMatchObject({ code: -32001 });
  });

  it('type errors (-32002)', () => {
    expect(rejection(`${S} AND complete != true`)).toEqual({
      code: -32002,
      message: '!= is not part of the query language — write NOT (attr = value) for the complement',
      position: 62,
    });
    expect(rejection(`${S} AND chunkcount BETWEEN u64(1) AND i32(5)`)).toEqual({
      code: -32002,
      message: 'BETWEEN bounds must be of one type, but they are u64 and i32',
      position: 83,
    });
    expect(rejection(`${S} AND x STARTSWITH i32(1)`)).toEqual({
      code: -32002,
      message: "STARTSWITH matches a string prefix — write str('…')",
      position: 66,
    });
    expect(rejection(`${S} AND EXISTS($key)`)).toEqual({
      code: -32002,
      message:
        '$key is a system attribute, which every entity carries — exists and typeof take a user attribute',
      position: 60,
    });
    expect(rejection(`${S} AND TYPEOF($owner) = addr`)).toMatchObject({ code: -32002, position: 60 });
    expect(rejection(`${S} AND TYPEOF(metadata) = bytes`)).toEqual({
      code: -32002,
      message: 'bytes is not a type tag — one of i32 u64 u256 dec str addr key bytes32 bool',
      position: 72,
    });
    expect(rejection(`${S} AND TYPEOF(complete) = banana`)).toMatchObject({
      code: -32002,
      message: 'banana is not a type tag — one of i32 u64 u256 dec str addr key bytes32 bool',
    });
    expect(rejection(`${S} AND $createdAt > u64(1)`)).toEqual({
      code: -32002,
      message: '$createdAt is not queryable — it is returned by projections only',
      position: 53,
    });
    expect(rejection(`${S} ORDER BY $createdAt:u64 ASC`)).toMatchObject({ code: -32002, position: 58 });
    expect(rejection(`${S} AND $nope = i32(1)`)).toEqual({
      code: -32002,
      message: 'unknown system attribute $nope — expected $key, $owner, $creator or $expiresAt',
      position: 53,
    });
    expect(rejection("$owner = str('x')")).toEqual({
      code: -32002,
      message: 'this system attribute holds addr, but the value is str',
      position: 9,
    });
    expect(rejection(`${S} ORDER BY $key:str ASC`)).toEqual({
      code: -32002,
      message: '$key holds key, so it sorts as key — not as str',
      position: 63,
    });
    expect(rejection(`${S} ORDER BY totalbytes`)).toEqual({
      code: -32002,
      message:
        'totalbytes can hold any type, so ORDER BY names the one to sort it as — write ORDER BY totalbytes:str, or another tag',
      position: 58,
    });
  });

  it('literal errors (-32003)', () => {
    expect(rejection(`${S} AND x = i32(99999999999)`)).toEqual({
      code: -32003,
      message: 'value is out of range for i32 [-2147483648, 2147483647] — use u256(…) for larger numbers',
      position: 61,
    });
    expect(rejection(`${S} AND x = i32(1.5)`)).toEqual({
      code: -32003,
      message: 'i32 expects decimal digits',
      position: 61,
    });
    expect(rejection(`${S} AND x = dec(1e5)`)).toEqual({
      code: -32003,
      message: 'dec expects decimal digits',
      position: 61,
    });
    expect(rejection(`${S} AND x = u64(-1)`)).toEqual({
      code: -32003,
      message: 'u64 is unsigned — remove the sign, or use i32(…)',
      position: 61,
    });
    expect(rejection(`${S} AND complete = bool(true)`)).toEqual({
      code: -32003,
      message: 'bool takes no wrapper — write the literal true or false',
      position: 69,
    });
    expect(rejection('$owner = addr(0x12)')).toEqual({
      code: -32003,
      message: 'an address is 0x followed by exactly 40 hex digits',
      position: 14,
    });
    expect(rejection('$owner = addr(0x3F0f89bfe9afd97a4d9fed6eb032794da293c0fb)')).toEqual({
      code: -32003,
      message: 'address fails its EIP-55 checksum — fix the capitalization, or write it all-lowercase',
      position: 14,
    });
    expect(rejection('$key = key(0x1234)')).toEqual({
      code: -32003,
      message: 'expected 0x followed by exactly 64 hex digits',
      position: 11,
    });
    expect(rejection('arkiv.schema = str(abc)')).toEqual({
      code: -32003,
      message: "str takes a single-quoted string, e.g. str('Bob')",
      position: 19,
    });
  });

  it('accepts a correctly checksummed or all-lowercase address', () => {
    expect(() => parseQuery('$owner = addr(0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045)')).not.toThrow();
    expect(() => parseQuery('$owner = addr(0xd8da6bf26964af9d7eed9e03e53415d37aa96045)')).not.toThrow();
  });

  it('parses NOT but answers it as not implemented, like the node (-32603)', () => {
    expect(rejection(`${S} AND NOT complete = true`)).toMatchObject({ code: -32603 });
    expect(rejection('NOT (a = i32(1) OR b = i32(2))')).toMatchObject({ code: -32603 });
  });
});
