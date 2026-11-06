/**
 * The devnet's in-memory picture of an entity, and the two encodings of an attribute value:
 * the bytes the engine receives, and the JSON `arkiv_query` renders.
 *
 * Sources: docs.arkiv.network/json-rpc/mutating-entities (wire types) and
 * docs.arkiv.network/json-rpc/querying-data (JSON rendering), cross-checked against responses
 * of the Rabdi testnet.
 */
import { type Hex, bytesToHex, hexToBytes, parseAbi } from 'viem';

/** Where Arkiv's entity engine lives, on every Arkiv chain. */
export const ARKIV_ENGINE_ADDRESS = '0x4400000000000000000000000000000000000044' as const;

/** The longest an entity may live, in blocks, from the block the operation lands in. */
export const MAX_LIFETIME = 7_884_000n;

/** Rows `arkiv_query` returns at most, and by default. */
export const MAX_LIMIT = 100;

/** The engine's events. `DevAttributes` is this devnet's own addition (see ArkivDevEngine.sol). */
export const ENGINE_EVENTS_ABI = parseAbi([
  'struct Attribute { bytes32 name; uint8 typeId; bytes value; }',
  'event EntityCreated(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags)',
  'event EntityPatched(bytes32 indexed entityKey, address indexed owner)',
  'event ExpiryExtended(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt)',
  'event OwnershipTransferred(bytes32 indexed entityKey, address indexed previousOwner, address indexed newOwner)',
  'event EntityDeleted(bytes32 indexed entityKey, address indexed owner)',
  'event DevAttributes(bytes32 indexed entityKey, Attribute[] attributes)',
]);

/**
 * Attribute types. `bytes32` is typeId 6: the write spec lists it as reserved and the SDK does
 * not expose it, but Rabdi stores and returns attributes of that type, so the devnet does too.
 */
export const TYPE_TAGS = {
  1: 'bool',
  2: 'i32',
  3: 'u64',
  4: 'u256',
  5: 'dec',
  6: 'bytes32',
  7: 'bytes',
  8: 'str',
  9: 'addr',
  10: 'key',
} as const;
export type TypeTag = (typeof TYPE_TAGS)[keyof typeof TYPE_TAGS];
export const TYPE_NAMES = new Set<string>(Object.values(TYPE_TAGS));

export const TOMBSTONE_TYPE_ID = 0;
export const INDEXED_FLAG = 0x80;

/** The types whose value is one 32-byte word compared as a number. */
const NUMERIC: ReadonlySet<TypeTag> = new Set(['bool', 'i32', 'u64', 'u256', 'dec']);
const DECIMAL_UNIT = 10n ** 18n;

/**
 * A value in the form conditions and sorts compare: a bigint for the numeric types (`bool` as
 * 0/1, `dec` scaled by 10^18), raw bytes for everything compared byte by byte.
 */
export type Comparable = { type: TypeTag; num?: bigint; bytes?: Uint8Array };

export type StoredAttribute = {
  name: string;
  type: TypeTag;
  indexed: boolean;
  /** The value bytes exactly as the engine received them. */
  raw: Uint8Array;
};

export type StoredEntity = {
  key: Hex;
  owner: Hex;
  creator: Hex;
  createdAt: bigint;
  updatedAt: bigint;
  expiresAt: bigint;
  creationFlags: number;
  attributes: Map<string, StoredAttribute>;
  /** Position in creation order, which is the order a query without ORDER BY returns. */
  sequence: number;
};

/** An attribute name as text: the bytes32 cell up to its first zero byte. */
export function nameFromIdent32(ident: Hex): string {
  const bytes = hexToBytes(ident);
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function wordOf(raw: Uint8Array): bigint {
  return raw.length === 0 ? 0n : BigInt(bytesToHex(raw));
}

/** The comparable form of a stored attribute. */
export function comparableOf(attribute: StoredAttribute): Comparable {
  const { type, raw } = attribute;
  if (NUMERIC.has(type)) {
    const word = wordOf(raw);
    if (type === 'i32') return { type, num: BigInt.asIntN(32, word) };
    if (type === 'dec') return { type, num: BigInt.asIntN(256, word) };
    return { type, num: word };
  }
  // An address is compared as its 20 bytes, not as the 32-byte word it travels in.
  if (type === 'addr') return { type, bytes: raw.subarray(raw.length - 20) };
  return { type, bytes: raw };
}

/** Three-way comparison in index order: numbers by value, everything else byte by byte. */
export function compareValues(a: Comparable, b: Comparable): number {
  if (a.num !== undefined && b.num !== undefined) return a.num < b.num ? -1 : a.num > b.num ? 1 : 0;
  const x = a.bytes ?? new Uint8Array();
  const y = b.bytes ?? new Uint8Array();
  const shared = Math.min(x.length, y.length);
  for (let i = 0; i < shared; i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

export function unitsToDecimal(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const fraction = (magnitude % DECIMAL_UNIT).toString().padStart(18, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fraction ? `${sign}${magnitude / DECIMAL_UNIT}.${fraction}` : `${sign}${magnitude / DECIMAL_UNIT}`;
}

/**
 * The JSON form of a value. It follows the declared type, never the magnitude: `bool` a JSON
 * boolean, `i32` a number, `u64`/`u256` a hex quantity, `dec` a decimal string, `str` a string,
 * and the byte-shaped types hex data.
 */
export function jsonValueOf(attribute: StoredAttribute): unknown {
  const { type, raw } = attribute;
  switch (type) {
    case 'bool':
      return wordOf(raw) !== 0n;
    case 'i32':
      return Number(BigInt.asIntN(32, wordOf(raw)));
    case 'u64':
    case 'u256':
      return `0x${wordOf(raw).toString(16)}`;
    case 'dec':
      return unitsToDecimal(BigInt.asIntN(256, wordOf(raw)));
    case 'str':
      return new TextDecoder().decode(raw);
    case 'addr':
      return bytesToHex(raw.subarray(raw.length - 20));
    case 'bytes':
    case 'bytes32':
    case 'key':
      return bytesToHex(raw);
  }
}
