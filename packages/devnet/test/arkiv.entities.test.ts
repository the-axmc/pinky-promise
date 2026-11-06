/**
 * Acceptance tests for the local Arkiv devnet: every write operation, driven through the
 * unmodified `@arkiv-network/sdk` exactly as an application would use it.
 */
import {
  EntityMutationError,
  ExpirationTime,
  NoEntityFoundError,
  createPublicClient,
  createWalletClient,
} from '@arkiv-network/sdk';
import { asc, eq } from '@arkiv-network/sdk/query';
import { addr, bool, bytes, dec, defineSchema, i32, key, str, u64, u256 } from '@arkiv-network/sdk/schema';
import { type Hex, encodeAbiParameters, getAddress, http, parseAbi, parseAbiParameters, stringToBytes, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
// The SDK's client type exposes a curated subset of viem's public actions, so the rest are
// called as standalone actions.
import { getGasPrice, simulateContract } from 'viem/actions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARKIV_ENGINE_ADDRESS, type ArkivDevnet, startArkivDevnet } from '../src/arkiv/index';

/** One column of every type, plus an optional and a defaulted one. */
const Everything = defineSchema('test.everything', {
  flag: bool().indexed(),
  small: i32().indexed(),
  when: u64().indexed(),
  big: u256().indexed(),
  price: dec().indexed(),
  label: str().indexed(),
  who: addr().indexed(),
  ref: key().indexed(),
  blob: bytes(),
  note: str().optional(),
  kind: str().default('thing'),
});

const Notes = defineSchema('test.notes', {
  topic: str().indexed(),
  text: str(),
  parent: key().indexed().optional(),
});

let devnet: ArkivDevnet;
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());

function clients(account: typeof alice) {
  return {
    reader: createPublicClient({ chain: devnet.chain, transport: http(), cacheTime: 0 }),
    wallet: createWalletClient({ chain: devnet.chain, transport: http(), account, cacheTime: 0 }),
  };
}

const someKey = `0x${'ab'.repeat(32)}` as Hex;
const everythingValues = () => ({
  flag: true,
  small: -7,
  when: u64(1_700_000_000n),
  big: 2n ** 200n,
  price: dec('-0.25'),
  label: 'héllo wörld',
  who: addr(bob.address),
  ref: key(someKey),
  blob: stringToBytes('raw bytes \u0000 with a zero'),
});

beforeAll(async () => {
  devnet = await startArkivDevnet({ blockTime: 0 });
  await devnet.fund(alice.address);
  await devnet.fund(bob.address);
});

afterAll(async () => {
  await devnet?.stop();
});

describe('create', () => {
  it('stores every column type and reads each value back unchanged', async () => {
    const { reader, wallet } = clients(alice);
    const [predicted] = await reader.predictEntityKeys({ owner: alice.address, salts: [42n] });

    const created = await wallet.createEntity(Everything, everythingValues(), {
      expiration: ExpirationTime.fromBlocks(1000),
      salt: 42n,
    });
    expect(created.entityKey).toBe(predicted!.key);

    const receipt = await reader.getTransactionReceipt({ hash: created.txHash });
    expect(receipt.status).toBe('success');
    expect(created.expiresAt).toBe(receipt.blockNumber + 1000n);

    const row = await reader.getEntity(created.entityKey, Everything);
    expect(row.flag.value).toBe(true);
    expect(row.small.value).toBe(-7);
    expect(row.when.value).toBe(1_700_000_000n);
    expect(row.big.value).toBe(2n ** 200n);
    expect(row.price.value).toBe('-0.25');
    expect(row.label.value).toBe('héllo wörld');
    expect(row.who.value).toBe(getAddress(bob.address));
    expect(row.ref.value).toBe(someKey);
    expect(row.blob.value).toBe(toHex(stringToBytes('raw bytes \u0000 with a zero')));
    expect(row.note).toBeUndefined();
    expect(row.kind.value).toBe('thing');

    expect(row.$key).toBe(created.entityKey);
    expect(row.$owner).toBe(getAddress(alice.address));
    expect(row.$creator).toBe(getAddress(alice.address));
    expect(row.$createdAt).toBe(receipt.blockNumber);
    expect(row.$updatedAt).toBe(receipt.blockNumber);
    expect(row.$expiresAt).toBe(created.expiresAt);
    expect(row.$creationFlags).toEqual({ readonly: false, permissionlessExtension: false, raw: 0 });
  });

  it('accepts explicit nonce, gas and gasPrice (the path recommended for Rabdi)', async () => {
    const { reader, wallet } = clients(alice);
    const nonce = await reader.getTransactionCount({ address: alice.address, blockTag: 'latest' });
    const gasPrice = await getGasPrice(reader);

    const created = await wallet.createEntity(
      Notes,
      { topic: 'gas', text: 'explicit' },
      { expiration: ExpirationTime.fromDays(1) },
      { nonce, gas: 1_000_000n, gasPrice },
    );

    const tx = await reader.getTransaction({ hash: created.txHash });
    expect(tx.nonce).toBe(nonce);
    expect(tx.gas).toBe(1_000_000n);
    expect(tx.gasPrice).toBe(gasPrice);
    expect(tx.to?.toLowerCase()).toBe(ARKIV_ENGINE_ADDRESS);
    // One day at the SDK's nominal 2-second block time.
    const receipt = await reader.getTransactionReceipt({ hash: created.txHash });
    expect(created.expiresAt).toBe(receipt.blockNumber + 43_200n);
  });

  it('keeps the creation flags', async () => {
    const { reader, wallet } = clients(alice);
    const { entityKey } = await wallet.createEntity(
      Notes,
      { topic: 'flags', text: 'both' },
      { expiration: ExpirationTime.fromBlocks(500), flags: { readonly: true, permissionlessExtension: true } },
    );
    const row = await reader.getEntity(entityKey, Notes);
    expect(row.$creationFlags).toEqual({ readonly: true, permissionlessExtension: true, raw: 3 });
  });

  it('gives each account its own entity nonce when two wallets write interleaved', async () => {
    const a = clients(alice);
    const b = clients(bob);
    const before = {
      alice: await a.reader.getEntityNonce(alice.address),
      bob: await a.reader.getEntityNonce(bob.address),
    };

    const keys: Hex[] = [];
    for (const who of [a, b, a, b]) {
      const { entityKey } = await who.wallet.createEntity(
        Notes,
        { topic: 'interleaved', text: who === a ? 'from alice' : 'from bob' },
        { expiration: ExpirationTime.fromBlocks(500) },
      );
      keys.push(entityKey);
    }
    expect(new Set(keys).size).toBe(4);
    expect(await a.reader.getEntityNonce(alice.address)).toBe(before.alice + 2n);
    expect(await a.reader.getEntityNonce(bob.address)).toBe(before.bob + 2n);

    const mine = await a.reader
      .select({ $key: true, text: true })
      .from(Notes)
      .where(eq('topic', 'interleaved'))
      .createdBy(alice.address)
      .fetch();
    expect(mine.entities.map((row) => row.text.value)).toEqual(['from alice', 'from alice']);
    expect(mine.entities.map((row) => row.$key).sort()).toEqual([keys[0], keys[2]].sort());
  });
});

describe('patch', () => {
  it('sets and unsets columns and moves $updatedAt', async () => {
    const { reader, wallet } = clients(alice);
    const { entityKey } = await wallet.createEntity(
      Everything,
      { ...everythingValues(), note: 'draft' },
      { expiration: ExpirationTime.fromBlocks(1000) },
    );
    const before = await reader.getEntity(entityKey, Everything);
    expect(before.note?.value).toBe('draft');

    await wallet.patchEntity(Everything, entityKey, { set: { label: 'renamed', small: 5 }, unset: ['note'] });

    const after = await reader.getEntity(entityKey, Everything);
    expect(after.label.value).toBe('renamed');
    expect(after.small.value).toBe(5);
    expect(after.note).toBeUndefined();
    expect(after.price.value).toBe('-0.25'); // untouched
    expect(after.$createdAt).toBe(before.$createdAt);
    expect(after.$updatedAt).toBeGreaterThan(before.$updatedAt);
    expect(after.$expiresAt).toBe(before.$expiresAt);
  });

  it('is refused for a readonly entity, and the SDK names the reason', async () => {
    const { reader, wallet } = clients(alice);
    const { entityKey } = await wallet.createEntity(
      Notes,
      { topic: 'readonly', text: 'fixed' },
      { expiration: ExpirationTime.fromBlocks(500), flags: { readonly: true } },
    );

    // Gas estimation already runs into the engine's revert.
    const estimated = wallet.patchEntity(Notes, entityKey, { set: { text: 'changed' } });
    await expect(estimated).rejects.toBeInstanceOf(EntityMutationError);
    await expect(estimated).rejects.toThrow(/created readonly/);

    // With explicit gas the transaction is mined and reverts; the SDK still explains it.
    const sent = wallet
      .patchEntity(Notes, entityKey, { set: { text: 'changed' } }, { gas: 1_000_000n })
      .catch((error: unknown) => error);
    const error = (await sent) as EntityMutationError;
    expect(error).toBeInstanceOf(EntityMutationError);
    expect(error.message).toMatch(/reverted.*created readonly/s);
    expect(error.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await reader.getTransactionReceipt({ hash: error.txHash! })).status).toBe('reverted');

    expect((await reader.getEntity(entityKey, Notes)).text.value).toBe('fixed');
  });

  it('is refused for an account that does not own the entity', async () => {
    const a = clients(alice);
    const b = clients(bob);
    const { entityKey } = await a.wallet.createEntity(
      Notes,
      { topic: 'ownership', text: 'alice wrote this' },
      { expiration: ExpirationTime.fromBlocks(500) },
    );
    await expect(b.wallet.patchEntity(Notes, entityKey, { set: { text: 'bob was here' } })).rejects.toThrow(/is owned by/);
  });
});

describe('extend', () => {
  it('lets the owner push the expiry out, never in', async () => {
    const { reader, wallet } = clients(alice);
    const created = await wallet.createEntity(
      Notes,
      { topic: 'extend', text: 'owner' },
      { expiration: ExpirationTime.fromBlocks(100) },
    );

    const extended = await wallet.extendEntity({ entityKey: created.entityKey, expiration: ExpirationTime.fromBlocks(5000) });
    expect(extended.expiresAt).toBeGreaterThan(created.expiresAt);
    const row = await reader.getEntity(created.entityKey, Notes);
    expect(row.$expiresAt).toBe(extended.expiresAt);
    expect(row.$updatedAt).toBe(row.$createdAt); // an extension is not a patch

    await expect(
      wallet.extendEntity({ entityKey: created.entityKey, expiration: ExpirationTime.fromBlocks(10) }),
    ).rejects.toThrow(/would shorten its life/);
  });

  it('is open to anyone only when the entity was created with permissionlessExtension', async () => {
    const a = clients(alice);
    const b = clients(bob);
    const closed = await a.wallet.createEntity(
      Notes,
      { topic: 'extend', text: 'closed' },
      { expiration: ExpirationTime.fromBlocks(100) },
    );
    const open = await a.wallet.createEntity(
      Notes,
      { topic: 'extend', text: 'open' },
      { expiration: ExpirationTime.fromBlocks(100), flags: { permissionlessExtension: true } },
    );

    await expect(
      b.wallet.extendEntity({ entityKey: closed.entityKey, expiration: ExpirationTime.fromBlocks(5000) }),
    ).rejects.toThrow(/is owned by/);

    const extended = await b.wallet.extendEntity({ entityKey: open.entityKey, expiration: ExpirationTime.fromBlocks(5000) });
    const row = await a.reader.getEntity(open.entityKey, Notes);
    expect(row.$expiresAt).toBe(extended.expiresAt);
    expect(row.$owner).toBe(getAddress(alice.address)); // extending does not change the owner
  });
});

describe('ownership', () => {
  it('moves $owner, keeps $creator, and takes write access with it', async () => {
    const a = clients(alice);
    const b = clients(bob);
    const { entityKey } = await a.wallet.createEntity(
      Notes,
      { topic: 'transfer', text: 'v1' },
      { expiration: ExpirationTime.fromBlocks(500) },
    );

    await a.wallet.changeOwnership({ entityKey, newOwner: bob.address });

    const row = await a.reader.getEntity(entityKey, Notes);
    expect(row.$owner).toBe(getAddress(bob.address));
    expect(row.$creator).toBe(getAddress(alice.address));

    await expect(a.wallet.patchEntity(Notes, entityKey, { set: { text: 'v2 by alice' } })).rejects.toThrow(/is owned by/);
    await b.wallet.patchEntity(Notes, entityKey, { set: { text: 'v2 by bob' } });
    expect((await a.reader.getEntity(entityKey, Notes)).text.value).toBe('v2 by bob');

    const ownedByBob = await a.reader.select({ $key: true }).from(Notes).where(eq('topic', 'transfer')).ownedBy(bob.address).fetch();
    const createdByAlice = await a.reader.select({ $key: true }).from(Notes).where(eq('topic', 'transfer')).createdBy(alice.address).fetch();
    const ownedByAlice = await a.reader.select({ $key: true }).from(Notes).where(eq('topic', 'transfer')).ownedBy(alice.address).fetch();
    expect(ownedByBob.entities.map((r) => r.$key)).toEqual([entityKey]);
    expect(createdByAlice.entities.map((r) => r.$key)).toEqual([entityKey]);
    expect(ownedByAlice.entities).toEqual([]);
  });

  it('cannot go to the current owner or the zero address', async () => {
    const { wallet } = clients(alice);
    const { entityKey } = await wallet.createEntity(
      Notes,
      { topic: 'transfer-rules', text: 'x' },
      { expiration: ExpirationTime.fromBlocks(500) },
    );
    await expect(wallet.changeOwnership({ entityKey, newOwner: alice.address })).rejects.toThrow(/already owned by that account/);
    await expect(
      wallet.changeOwnership({ entityKey, newOwner: '0x0000000000000000000000000000000000000000' }),
    ).rejects.toThrow(/zero address/);
  });
});

describe('delete', () => {
  it('removes the entity from reads and queries', async () => {
    const { reader, wallet } = clients(alice);
    const { entityKey } = await wallet.createEntity(
      Notes,
      { topic: 'delete-me', text: 'short lived' },
      { expiration: ExpirationTime.fromBlocks(500) },
    );
    expect(await reader.count().from(Notes).where(eq('topic', 'delete-me')).fetch()).toBe(1n);

    await wallet.deleteEntity({ entityKey });

    await expect(reader.getEntity(entityKey)).rejects.toBeInstanceOf(NoEntityFoundError);
    expect(await reader.count().from(Notes).where(eq('topic', 'delete-me')).fetch()).toBe(0n);
    await expect(wallet.deleteEntity({ entityKey })).rejects.toThrow(/no entity/);
  });
});

describe('batch', () => {
  it('applies creates, patches, extensions, transfers and deletes in one transaction', async () => {
    const { reader, wallet } = clients(alice);
    const expiration = ExpirationTime.fromBlocks(500);
    const make = async (text: string) =>
      (await wallet.createEntity(Notes, { topic: 'batch', text }, { expiration })).entityKey;
    const toPatch = await make('to patch');
    const toExtend = await make('to extend');
    const toTransfer = await make('to transfer');
    const toDelete = await make('to delete');

    // The second create points at the first, whose key does not exist yet.
    const [parent, child] = await reader.predictEntityKeys({ owner: alice.address, count: 2 });
    const result = await wallet.executeBatch({
      creates: [
        { schema: Notes, values: { topic: 'batch', text: 'parent' }, expiration, salt: parent!.salt },
        { schema: Notes, values: { topic: 'batch', text: 'child', parent: key(parent!.key) }, expiration, salt: child!.salt },
      ],
      patches: [{ schema: Notes, entityKey: toPatch, set: { text: 'patched' } }],
      extensions: [{ entityKey: toExtend, expiration: ExpirationTime.fromBlocks(9000) }],
      ownershipChanges: [{ entityKey: toTransfer, newOwner: bob.address }],
      deletes: [{ entityKey: toDelete }],
    });

    expect(result.createdEntities).toEqual([parent!.key, child!.key]);
    const receipt = await reader.getTransactionReceipt({ hash: result.txHash });
    expect((await reader.getEntity(child!.key, Notes)).parent?.value).toBe(parent!.key);
    expect((await reader.getEntity(toPatch, Notes)).text.value).toBe('patched');
    expect((await reader.getEntity(toExtend, Notes)).$expiresAt).toBe(receipt.blockNumber + 9000n);
    expect((await reader.getEntity(toTransfer, Notes)).$owner).toBe(getAddress(bob.address));
    await expect(reader.getEntity(toDelete)).rejects.toBeInstanceOf(NoEntityFoundError);

    const children = await reader.select({ text: true }).from(Notes).where(eq('parent', key(parent!.key))).fetch();
    expect(children.entities.map((row) => row.text.value)).toEqual(['child']);
  });

  it('is atomic: one refused operation reverts the whole batch', async () => {
    const { reader, wallet } = clients(alice);
    const expiration = ExpirationTime.fromBlocks(500);
    const frozen = await wallet.createEntity(Notes, { topic: 'atomic', text: 'readonly' }, { expiration, flags: { readonly: true } });
    const countBefore = await reader.count().from(Notes).where(eq('topic', 'atomic')).fetch();
    const nonceBefore = await reader.getEntityNonce(alice.address);

    await expect(
      wallet.executeBatch({
        creates: [
          { schema: Notes, values: { topic: 'atomic', text: 'would be created' }, expiration },
          { schema: Notes, values: { topic: 'atomic', text: 'this one too' }, expiration },
        ],
        patches: [{ schema: Notes, entityKey: frozen.entityKey, set: { text: 'not allowed' } }],
      }),
    ).rejects.toThrow(/created readonly/);

    expect(await reader.count().from(Notes).where(eq('topic', 'atomic')).fetch()).toBe(countBefore);
    expect(await reader.getEntityNonce(alice.address)).toBe(nonceBefore);
  });
});

describe('expiry', () => {
  it('makes an entity disappear once the chain passes its expiry block', async () => {
    const { reader, wallet } = clients(alice);
    const created = await wallet.createEntity(
      Notes,
      { topic: 'expiring', text: 'gone soon' },
      { expiration: ExpirationTime.fromBlocks(5) },
    );
    expect((await reader.getEntity(created.entityKey, Notes)).text.value).toBe('gone soon');

    // Still there on the last block before the expiry block...
    const toGo = created.expiresAt - 1n - (await devnet.blockNumber());
    if (toGo > 0n) await devnet.mine(Number(toGo));
    expect(await devnet.blockNumber()).toBe(created.expiresAt - 1n);
    expect(await reader.count().from(Notes).where(eq('topic', 'expiring')).fetch()).toBe(1n);

    // ...and gone at the expiry block. No event marks it.
    await devnet.mine(1);
    await expect(reader.getEntity(created.entityKey)).rejects.toBeInstanceOf(NoEntityFoundError);
    expect(await reader.count().from(Notes).where(eq('topic', 'expiring')).fetch()).toBe(0n);
    const page = await reader.select({ $key: true }).from(Notes).where(eq('topic', 'expiring')).fetch();
    expect(page.entities).toEqual([]);

    await expect(wallet.patchEntity(Notes, created.entityKey, { set: { text: 'too late' } })).rejects.toThrow(/expired/);
    await expect(
      wallet.extendEntity({ entityKey: created.entityKey, expiration: ExpirationTime.fromBlocks(100) }),
    ).rejects.toThrow(/expired/);
  });
});

describe('events', () => {
  it('delivers each operation to watchEntityEvents, in order, without the devnet-only event', async () => {
    const { reader, wallet } = clients(alice);
    const seen: string[] = [];
    const errors: Error[] = [];
    const unwatch = reader.watchEntityEvents({
      onEvent: (event) => seen.push(event.type),
      onError: (error) => errors.push(error),
      pollingInterval: 100,
    });
    try {
      // Give the log filter a moment to be installed before the first write.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { entityKey } = await wallet.createEntity(
        Notes,
        { topic: 'events', text: 'watched' },
        { expiration: ExpirationTime.fromBlocks(500) },
      );
      await wallet.patchEntity(Notes, entityKey, { set: { text: 'patched' } });
      await wallet.extendEntity({ entityKey, expiration: ExpirationTime.fromBlocks(5000) });
      await wallet.changeOwnership({ entityKey, newOwner: bob.address });
      await clients(bob).wallet.deleteEntity({ entityKey });

      const deadline = Date.now() + 5000;
      while (seen.length < 5 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      unwatch();
    }
    expect(seen).toEqual(['EntityCreated', 'EntityPatched', 'ExpiryExtended', 'OwnershipTransferred', 'EntityDeleted']);
    expect(errors).toEqual([]);
  });
});

describe('replica', () => {
  it('is rebuilt from the chain when the proxy restarts', async () => {
    const { reader } = clients(alice);
    const everything = () =>
      reader
        .select({
          $key: true,
          $owner: true,
          $creator: true,
          $createdAt: true,
          $updatedAt: true,
          $expiresAt: true,
          $creationFlags: true,
          $attributes: true,
          $attributeSchema: true,
        })
        .createdBy(alice.address)
        .orderBy(asc('$key'))
        .limit(100)
        .fetch();

    const before = await everything();
    expect(before.entities.length).toBeGreaterThan(10);

    await devnet.restartProxy();

    const after = await everything();
    expect(after.entities).toEqual(before.entities);
  });
});

describe('engine rules the SDK never lets through', () => {
  // The SDK validates before it sends, so these go to the engine as raw calldata.
  const abi = parseAbi([
    'function execute((uint8 operation, bytes operationData)[] ops) returns (bytes32[] keys)',
    'error EmptyBatch()',
    'error InvalidOpType(uint8 operation)',
    'error NonCanonicalOperationData(uint8 operation)',
    'error AttributesNotSorted()',
    'error TombstoneInCreate(bytes32 name)',
    'error SystemAttributeNotWritable(bytes32 name)',
    'error InvalidValueType(bytes32 name, uint8 typeId)',
    'error Ident32InvalidByte(uint256 position, bytes1 value)',
    'error ReservedCreationFlags(uint8 creationFlags)',
    'error ExpiryDeadOnArrival(uint64 target, uint64 currentBlock)',
    'error ExpiryBeyondMaxLifetime(uint64 target, uint64 currentBlock, uint64 maxLifetime)',
  ]);
  const createParams = parseAbiParameters(
    '(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)',
  );
  const attribute = (name: string, typeId: number, value: Hex) => ({ name: toHex(name, { size: 32 }), typeId, value });
  const word = (value: bigint) => toHex(value, { size: 32 });

  type Create = Partial<{ expiresAt: bigint; minLifetime: bigint; creationFlags: number; attributes: ReturnType<typeof attribute>[] }>;
  const create = (overrides: Create = {}) => ({
    operation: 1,
    operationData: encodeAbiParameters(createParams, [
      { salt: 1n, expiresAt: 0n, minLifetime: 100n, creationFlags: 0, attributes: [], ...overrides },
    ]),
  });

  async function refusal(ops: { operation: number; operationData: Hex }[]): Promise<string> {
    const { reader } = clients(alice);
    try {
      await simulateContract(reader, { address: ARKIV_ENGINE_ADDRESS, abi, functionName: 'execute', args: [ops], account: alice.address });
      return 'accepted';
    } catch (error) {
      const walked = (error as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk?.((e) => (e as { data?: { errorName?: string } })?.data?.errorName !== undefined);
      return (walked as { data?: { errorName?: string } } | undefined)?.data?.errorName ?? String((error as Error).message).slice(0, 120);
    }
  }

  it('accepts a well-formed create (the control case)', async () => {
    expect(await refusal([create({ attributes: [attribute('a', 0x88, toHex('x')), attribute('b', 2, word(1n))] })])).toBe('accepted');
  });

  it('rejects an empty batch and an unknown operation tag', async () => {
    expect(await refusal([])).toBe('EmptyBatch');
    expect(await refusal([{ operation: 9, operationData: '0x' }])).toBe('InvalidOpType');
  });

  it('rejects operation data that is not the canonical encoding', async () => {
    const good = create();
    expect(await refusal([{ operation: 1, operationData: `${good.operationData}00` as Hex }])).toBe('NonCanonicalOperationData');
    expect(await refusal([{ operation: 1, operationData: '0x1234' }])).toBe('NonCanonicalOperationData');
  });

  it('rejects unsorted or duplicated attribute names', async () => {
    const a = attribute('a', 2, word(1n));
    const b = attribute('b', 2, word(1n));
    expect(await refusal([create({ attributes: [b, a] })])).toBe('AttributesNotSorted');
    expect(await refusal([create({ attributes: [a, a] })])).toBe('AttributesNotSorted');
  });

  it('rejects reserved names, bad names and tombstones in a create', async () => {
    expect(await refusal([create({ attributes: [attribute('$owner', 9, word(1n))] })])).toBe('SystemAttributeNotWritable');
    expect(await refusal([create({ attributes: [attribute('has space', 2, word(1n))] })])).toBe('Ident32InvalidByte');
    expect(await refusal([create({ attributes: [attribute('9lives', 2, word(1n))] })])).toBe('Ident32InvalidByte');
    expect(await refusal([create({ attributes: [attribute('gone', 0, '0x')] })])).toBe('TombstoneInCreate');
  });

  it('rejects values that do not fit their type', async () => {
    expect(await refusal([create({ attributes: [attribute('blob', 0x87, '0x00')] })])).toBe('InvalidValueType'); // indexed bytes
    expect(await refusal([create({ attributes: [attribute('flag', 1, word(2n))] })])).toBe('InvalidValueType'); // bool 2
    expect(await refusal([create({ attributes: [attribute('n', 2, word(2n ** 40n))] })])).toBe('InvalidValueType'); // i32 too wide
    expect(await refusal([create({ attributes: [attribute('n', 3, word(2n ** 64n))] })])).toBe('InvalidValueType'); // u64 too wide
    expect(await refusal([create({ attributes: [attribute('n', 4, '0x01')] })])).toBe('InvalidValueType'); // not a word
    expect(await refusal([create({ attributes: [attribute('s', 8, toHex('x'.repeat(129)))] })])).toBe('InvalidValueType'); // str > 128 bytes
    expect(await refusal([create({ attributes: [attribute('t', 11, word(1n))] })])).toBe('InvalidValueType'); // unknown type
  });

  it('rejects reserved creation flags and out-of-bounds expiries', async () => {
    expect(await refusal([create({ creationFlags: 4 })])).toBe('ReservedCreationFlags');
    expect(await refusal([create({ expiresAt: 1n, minLifetime: 0n })])).toBe('ExpiryDeadOnArrival');
    expect(await refusal([create({ minLifetime: 7_884_001n })])).toBe('ExpiryBeyondMaxLifetime');
    expect(await refusal([create({ minLifetime: 7_884_000n })])).toBe('accepted');
  });
});
