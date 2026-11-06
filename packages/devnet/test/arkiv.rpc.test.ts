/**
 * Wire-level tests for the local Arkiv devnet: the JSON it answers `arkiv_*` calls with must
 * have the shape the real node uses. The expectations here were taken from responses of the
 * Rabdi testnet (https://rpc.rabdi.db-chain.testnet.arkiv.network) for the same requests.
 */
import { ExpirationTime, NoEntityFoundError, createPublicClient, createWalletClient } from '@arkiv-network/sdk';
import { eq } from '@arkiv-network/sdk/query';
import { addr, bool, bytes, dec, defineSchema, i32, key, str, u64, u256 } from '@arkiv-network/sdk/schema';
import { type Hex, http, stringToBytes, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ArkivDevnet, startArkivDevnet } from '../src/arkiv/index';

const Sample = defineSchema('test.wire', {
  flag: bool().indexed(),
  small: i32().indexed(),
  when: u64().indexed(),
  big: u256().indexed(),
  price: dec().indexed(),
  label: str().indexed(),
  who: addr().indexed(),
  ref: key().indexed(),
  blob: bytes(),
});

let devnet: ArkivDevnet;
const alice = privateKeyToAccount(generatePrivateKey());
const refKey = `0x${'cd'.repeat(32)}` as Hex;
let entityKey: Hex;
let createdAt: bigint;
let expiresAt: bigint;
let nextId = 1;

async function post(body: unknown, url = devnet.rpcUrl): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function call(method: string, params: unknown[] = []): Promise<any> {
  return post({ jsonrpc: '2.0', id: nextId++, method, params });
}

const TAG = "arkiv.schema = str('test.wire')";

beforeAll(async () => {
  devnet = await startArkivDevnet({ blockTime: 0 });
  await devnet.fund(alice.address);
  const wallet = createWalletClient({ chain: devnet.chain, transport: http(), account: alice, cacheTime: 0 });
  const reader = createPublicClient({ chain: devnet.chain, transport: http(), cacheTime: 0 });
  const values = (label: string, small: number) => ({
    flag: true,
    small,
    when: u64(1_700_000_000n),
    big: 2n ** 70n,
    price: dec('4.5'),
    label,
    who: addr(alice.address),
    ref: key(refKey),
    blob: stringToBytes('blob'),
  });
  const created = await wallet.createEntity(Sample, values('first', -3), { expiration: ExpirationTime.fromBlocks(5000) });
  entityKey = created.entityKey;
  expiresAt = created.expiresAt;
  createdAt = (await reader.getTransactionReceipt({ hash: created.txHash })).blockNumber;
  await wallet.createEntity(Sample, values('second', 8), { expiration: ExpirationTime.fromBlocks(5000) });
  await wallet.createEntity(Sample, values('third', 20), { expiration: ExpirationTime.fromBlocks(5000) });
});

afterAll(async () => {
  await devnet?.stop();
});

describe('arkiv_query response', () => {
  it('renders an entity with every field in the node order and JSON encoding', async () => {
    const select = {
      key: true,
      owner: true,
      creator: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
      creationFlags: true,
      attributeSchema: true,
      attributes: true,
      count: true,
    };
    const { result } = await call('arkiv_query', [`${TAG} AND label = str('first')`, { select, limit: '0x2' }]);

    expect(Object.keys(result)).toEqual(['data', 'blockNumber', 'count']);
    expect(result.count).toBe('0x1');
    expect(result.blockNumber).toBe(toHex(await devnet.blockNumber()));

    const [entity] = result.data;
    expect(Object.keys(entity)).toEqual([
      'key',
      'owner',
      'creator',
      'createdAt',
      'updatedAt',
      'expiresAt',
      'creationFlags',
      'attributeSchema',
      'attributes',
    ]);
    expect(entity.key).toBe(entityKey);
    expect(entity.owner).toBe(alice.address.toLowerCase());
    expect(entity.creator).toBe(alice.address.toLowerCase());
    expect(entity.createdAt).toBe(toHex(createdAt));
    expect(entity.updatedAt).toBe(toHex(createdAt));
    expect(entity.expiresAt).toBe(toHex(expiresAt));
    expect(entity.creationFlags).toEqual({ readonly: false, permissionlessExtension: false, raw: 0 });

    // Attributes are ordered by name, and each JSON value follows its declared type.
    expect(entity.attributes).toEqual([
      { name: 'arkiv.schema', type: 'str', value: 'test.wire' },
      { name: 'big', type: 'u256', value: '0x400000000000000000' },
      { name: 'blob', type: 'bytes', value: toHex(stringToBytes('blob')) },
      { name: 'flag', type: 'bool', value: true },
      { name: 'label', type: 'str', value: 'first' },
      { name: 'price', type: 'dec', value: '4.5' },
      { name: 'ref', type: 'key', value: refKey },
      { name: 'small', type: 'i32', value: -3 },
      { name: 'when', type: 'u64', value: '0x6553f100' },
      { name: 'who', type: 'addr', value: alice.address.toLowerCase() },
    ]);
    expect(entity.attributeSchema).toEqual([
      { name: 'arkiv.schema', type: 'str', indexed: true },
      { name: 'big', type: 'u256', indexed: true },
      { name: 'blob', type: 'bytes', indexed: false },
      { name: 'flag', type: 'bool', indexed: true },
      { name: 'label', type: 'str', indexed: true },
      { name: 'price', type: 'dec', indexed: true },
      { name: 'ref', type: 'key', indexed: true },
      { name: 'small', type: 'i32', indexed: true },
      { name: 'when', type: 'u64', indexed: true },
      { name: 'who', type: 'addr', indexed: true },
    ]);
  });

  it('returns only the key when no options are given, and up to 100 rows', async () => {
    const { result } = await call('arkiv_query', [TAG]);
    expect(Object.keys(result)).toEqual(['data', 'blockNumber']);
    expect(result.data).toHaveLength(3);
    for (const entity of result.data) expect(Object.keys(entity)).toEqual(['key']);
  });

  it('returns empty objects for an empty select, and no rows when only the count is selected', async () => {
    const empty = await call('arkiv_query', [TAG, { select: {} }]);
    expect(empty.result.data).toEqual([{}, {}, {}]);
    expect('count' in empty.result).toBe(false);

    const countOnly = await call('arkiv_query', [TAG, { select: { count: true } }]);
    expect(countOnly.result.data).toEqual([]);
    expect(countOnly.result.count).toBe('0x3');
  });

  it('returns a subset of attributes when select.attributes is a map of names', async () => {
    const { result } = await call('arkiv_query', [
      `${TAG} AND label = str('second')`,
      { select: { key: false, attributes: { label: true, small: true, missing: true } } },
    ]);
    expect(result.data).toEqual([
      {
        attributes: [
          { name: 'label', type: 'str', value: 'second' },
          { name: 'small', type: 'i32', value: 8 },
        ],
      },
    ]);
  });

  it('applies limit and offset, and an offset past the end is an empty page', async () => {
    const order = `${TAG} ORDER BY small:i32 ASC`;
    const select = { attributes: { label: true } };
    const labels = (answer: any) => answer.result.data.map((e: any) => e.attributes[0].value);
    expect(labels(await call('arkiv_query', [order, { select, limit: '0x2' }]))).toEqual(['first', 'second']);
    expect(labels(await call('arkiv_query', [order, { select, limit: '0x2', offset: '0x2' }]))).toEqual(['third']);
    const past = await call('arkiv_query', [order, { select: { key: true, count: true }, offset: '0xffff' }]);
    expect(past.result.data).toEqual([]);
    expect(past.result.count).toBe('0x3');
  });

  it('rejects a limit outside 1..100 as invalid params', async () => {
    const zero = await call('arkiv_query', [TAG, { limit: '0x0' }]);
    expect(zero.error).toEqual({ code: -32602, message: 'limit must be at least 1' });
    const tooMany = await call('arkiv_query', [TAG, { limit: '0x65' }]);
    expect(tooMany.error).toEqual({ code: -32602, message: 'limit 101 exceeds the node maximum of 100' });
  });
});

describe('arkiv_query errors', () => {
  const failure = async (query: string) => (await call('arkiv_query', [query])).error;

  it('reports parse errors with code -32001 and the position', async () => {
    const error = await failure('$owner = 0x0000000000000000000000000000000000000001');
    expect(error).toEqual({
      code: -32001,
      message: 'a hex literal must carry its type — write addr(0x…), key(0x…), bytes32(0x…) or u256(0x…)',
      data: {
        message: 'a hex literal must carry its type — write addr(0x…), key(0x…), bytes32(0x…) or u256(0x…)',
        position: 9,
      },
    });
    expect((await failure('label ='))?.code).toBe(-32001);
    expect((await failure("label = str('x') AND"))?.code).toBe(-32001);
    expect((await failure("(label = str('x')"))?.code).toBe(-32001);
    expect((await failure("label = str('unterminated"))?.code).toBe(-32001);
    expect((await failure(''))?.code).toBe(-32001);
  });

  it('reports type errors with code -32002', async () => {
    expect(await failure(`${TAG} AND flag != true`)).toMatchObject({
      code: -32002,
      message: '!= is not part of the query language — write NOT (attr = value) for the complement',
      // The position is where the offending token starts, as on the real node.
      data: { position: `${TAG} AND flag `.length },
    });
    expect(await failure(`${TAG} AND when BETWEEN u64(1) AND i32(5)`)).toMatchObject({
      code: -32002,
      message: 'BETWEEN bounds must be of one type, but they are u64 and i32',
    });
    expect(await failure(`${TAG} ORDER BY small`)).toMatchObject({
      code: -32002,
      message: 'small can hold any type, so ORDER BY names the one to sort it as — write ORDER BY small:str, or another tag',
    });
    expect((await failure(`${TAG} AND small STARTSWITH i32(1)`))?.code).toBe(-32002);
    expect((await failure(`$owner = str('alice')`))?.code).toBe(-32002);
    expect((await failure(`${TAG} ORDER BY $key:str`))?.code).toBe(-32002);
  });

  it('reports invalid literals with code -32003', async () => {
    expect(await failure(`${TAG} AND small = i32(99999999999)`)).toMatchObject({
      code: -32003,
      message: 'value is out of range for i32 [-2147483648, 2147483647] — use u256(…) for larger numbers',
    });
    expect(await failure('$owner = addr(0x3F0f89bfe9afd97a4d9fed6eb032794da293c0fb)')).toMatchObject({
      code: -32003,
      message: 'address fails its EIP-55 checksum — fix the capitalization, or write it all-lowercase',
    });
    expect(await failure('$key = key(0x1234)')).toMatchObject({
      code: -32003,
      message: 'expected 0x followed by exactly 64 hex digits',
    });
    expect((await failure(`${TAG} AND price = dec(1.0000000000000000001)`))?.code).toBe(-32003);
    expect((await failure(`${TAG} AND when = u64(-1)`))?.code).toBe(-32003);
  });

  it('answers NOT the way the real node does: parsed, but not implemented', async () => {
    const error = await failure(`${TAG} AND NOT flag = true`);
    expect(error.code).toBe(-32603);
    expect(error.message).toContain('NotImplemented');
  });

  it('accepts what the language allows beyond what the SDK writes', async () => {
    const count = async (query: string) => (await call('arkiv_query', [query, { select: { count: true } }])).result?.count;
    expect(await count(`${TAG} AND small = -3`)).toBe('0x1'); // a bare number is an i32
    expect(await count(`${TAG} and exists(label) -- lowercase keywords and a comment`)).toBe('0x3');
    expect(await count(`${TAG} AND big = u256(0x400000000000000000)`)).toBe('0x3'); // u256 in hex
    expect(await count(`${TAG} AND label = str('it''s')`)).toBe('0x0'); // doubled quote
    expect(await count(`${TAG} AND flag STARTSWITH str('a')`)).toBe('0x0'); // wrong attribute type: no match, no error
    expect(await count(`${TAG} AND TYPEOF(small) = i32 AND TYPEOF(small) = u64`)).toBe('0x0');
    expect(await count(`${TAG} AND $expiresAt > u64(1) AND $creator = addr(${alice.address.toLowerCase()})`)).toBe('0x3');
    expect(await count(`$key = key(${entityKey})`)).toBe('0x1');
  });
});

describe('arkiv_getEntity and arkiv_getBlockTiming', () => {
  it('returns every field except attributeSchema', async () => {
    const { result } = await call('arkiv_getEntity', [entityKey]);
    expect(Object.keys(result)).toEqual([
      'key',
      'owner',
      'creator',
      'createdAt',
      'updatedAt',
      'expiresAt',
      'creationFlags',
      'attributes',
    ]);
    expect(result.attributes).toHaveLength(10);
  });

  it('returns null for a key no live entity has, and rejects a malformed key', async () => {
    expect((await call('arkiv_getEntity', [`0x${'00'.repeat(32)}`])).result).toBeNull();
    expect((await call('arkiv_getEntity', ['0x1234'])).error.code).toBe(-32602);
  });

  it('reports the latest block, its time and the gap to the previous block', async () => {
    const { result } = await call('arkiv_getBlockTiming');
    expect(Object.keys(result)).toEqual(['current_block', 'current_block_time', 'duration']);
    expect(result.current_block).toBe(Number(await devnet.blockNumber()));
    expect(Math.abs(result.current_block_time - Date.now() / 1000)).toBeLessThan(600);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

describe('proxy', () => {
  it('forwards standard Ethereum methods to the chain', async () => {
    expect((await call('eth_chainId')).result).toBe('0x539');
    // entityNonce(address): selector 0x36917bfd, as in the write-transaction documentation.
    const nonce = await call('eth_call', [
      { to: '0x4400000000000000000000000000000000000044', data: `0x36917bfd000000000000000000000000${alice.address.slice(2)}` },
      'latest',
    ]);
    expect(BigInt(nonce.result)).toBe(3n);
    expect((await call('eth_getCode', ['0x4400000000000000000000000000000000000044', 'latest'])).result.length).toBeGreaterThan(1000);
  });

  it('answers a batch that mixes arkiv_* and standard calls, in request order', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 'a', method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 'b', method: 'arkiv_query', params: [TAG, { select: { count: true } }] },
      { jsonrpc: '2.0', id: 'c', method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 'd', method: 'arkiv_getEntity', params: [entityKey] },
      { jsonrpc: '2.0', id: 'e', method: 'arkiv_nope', params: [] },
    ];
    const answers = await post(batch);
    expect(answers.map((answer: any) => answer.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(answers[0].result).toBe('0x539');
    expect(answers[1].result.count).toBe('0x3');
    expect(answers[2].result).toBe(toHex(await devnet.blockNumber()));
    expect(answers[3].result.key).toBe(entityKey);
    expect(answers[4].error.code).toBe(-32601);
  });

  it('accepts a URL with a path segment, as Rabdi URLs carry an access key', async () => {
    const answer = await post({ jsonrpc: '2.0', id: 1, method: 'arkiv_query', params: [TAG, { select: { count: true } }] }, `${devnet.rpcUrl}/some-access-key`);
    expect(answer.result.count).toBe('0x3');
  });

  it('allows browsers: answers the CORS preflight and sets the header on responses', async () => {
    const preflight = await fetch(devnet.rpcUrl, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

    const response = await fetch(devnet.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const response = await fetch(devnet.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(((await response.json()) as any).error.code).toBe(-32700);
  });
});

describe('interval mining', () => {
  it('runs with a block time, and entities expire as blocks pass on their own', async () => {
    const timed = await startArkivDevnet({ blockTime: 1 });
    try {
      const account = privateKeyToAccount(generatePrivateKey());
      await timed.fund(account.address);
      const wallet = createWalletClient({ chain: timed.chain, transport: http(), account });
      const reader = createPublicClient({ chain: timed.chain, transport: http() });
      const Ticks = defineSchema('test.ticks', { name: str().indexed() });

      const created = await wallet.createEntity(Ticks, { name: 'short' }, { expiration: ExpirationTime.fromBlocks(3) });
      expect(await reader.count().from(Ticks).where(eq('name', 'short')).fetch()).toBe(1n);

      // No explicit mining here: the chain produces a block every second.
      const deadline = Date.now() + 15_000;
      while ((await timed.blockNumber()) < created.expiresAt) {
        if (Date.now() > deadline) throw new Error('the chain did not reach the expiry block in time');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await expect(reader.getEntity(created.entityKey)).rejects.toBeInstanceOf(NoEntityFoundError);
      expect(await reader.count().from(Ticks).where(eq('name', 'short')).fetch()).toBe(0n);
      expect((await reader.getBlockTiming()).blockDuration).toBe(1);
    } finally {
      await timed.stop();
    }
  }, 30_000);
});
