/**
 * Reads an Arkiv `execute` transaction back into the entities it would create.
 *
 * The device signs the Arkiv transactions that publish its readings (that is what makes the
 * device wallet the creator of those entities), but the transactions are assembled by the
 * gateway. Before signing, the device decodes the calldata with this module and checks it says
 * what the device itself measured — see packages/device/src/signing-policy.ts.
 *
 * Wire format (from the Arkiv SDK, src/entity/operations.ts and src/schema/codec.ts):
 *
 *   execute((uint8 operation, bytes operationData)[] ops)
 *   Create payload: (uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags,
 *                    (bytes32 name, uint8 typeId, bytes value)[] attributes)
 *   name    ASCII, zero-padded on the right
 *   typeId  low 7 bits = type, bit 7 = indexed
 *   value   bool / i32 / u64 / u256 / dec / addr / key: one 32-byte word; str: UTF-8; bytes: raw
 */
import { type Hex, decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiParameters } from 'viem';
import { ProtocolError, fromHex } from '../bytes';

/** Where every Arkiv entity operation is sent. */
export const ARKIV_ENGINE_ADDRESS = '0x4400000000000000000000000000000000000044' as const;

const EXECUTE_ABI = parseAbi([
  'function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)',
]);

const CREATE_PARAMS = parseAbiParameters(
  '(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)',
);

export const ARKIV_OPERATION = { create: 1, patch: 2, extendExpiry: 3, transferOwnership: 4, delete: 5 } as const;

const TYPE_TAGS: Record<number, ArkivTypeTag> = {
  1: 'bool',
  2: 'i32',
  3: 'u64',
  4: 'u256',
  5: 'dec',
  7: 'bytes',
  8: 'str',
  9: 'addr',
  10: 'key',
};
const INDEXED_FLAG = 0x80;
const READONLY_FLAG = 0x01;
const PERMISSIONLESS_EXTENSION_FLAG = 0x02;

export type ArkivTypeTag = 'bool' | 'i32' | 'u64' | 'u256' | 'dec' | 'bytes' | 'str' | 'addr' | 'key';

/**
 * An attribute in a form that compares with `===`: booleans, numbers for i32, bigints for the
 * other integers (dec as its scaled integer), strings for str, lowercase hex for the rest.
 */
export type PlainAttribute = {
  type: ArkivTypeTag;
  indexed: boolean;
  value: boolean | number | bigint | string;
};

export type DecodedCreate = {
  salt: bigint;
  expiresAt: bigint;
  minLifetime: bigint;
  readonly: boolean;
  permissionlessExtension: boolean;
  attributes: Map<string, PlainAttribute>;
};

export type DecodedExecute = {
  /** Operation tags in batch order (see {@link ARKIV_OPERATION}). */
  operations: number[];
  /** The decoded payload of every Create operation, in batch order. */
  creates: DecodedCreate[];
};

function attributeName(name: Hex): string {
  const bytes = fromHex(name, 32);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = String.fromCharCode(...bytes.subarray(0, end));
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(text)) throw new ProtocolError('Arkiv attribute name is not a valid identifier');
  return text;
}

function word(value: Hex, type: ArkivTypeTag): bigint {
  if (value.length !== 66) throw new ProtocolError(`Arkiv ${type} value must be one 32-byte word`);
  return BigInt(value);
}

/** Decodes one attribute value from its wire bytes into its plain form. */
export function decodePlainValue(type: ArkivTypeTag, value: Hex): PlainAttribute['value'] {
  switch (type) {
    case 'bool': {
      const raw = word(value, type);
      if (raw > 1n) throw new ProtocolError('Arkiv bool value must be 0 or 1');
      return raw === 1n;
    }
    case 'i32': {
      const narrowed = BigInt.asIntN(32, word(value, type));
      if (BigInt.asUintN(256, narrowed) !== BigInt(value)) throw new ProtocolError('Arkiv i32 value is not sign-extended');
      return Number(narrowed);
    }
    case 'u64': {
      const raw = word(value, type);
      if (raw >> 64n !== 0n) throw new ProtocolError('Arkiv u64 value overflows');
      return raw;
    }
    case 'u256':
      return word(value, type);
    case 'dec':
      return BigInt.asIntN(256, word(value, type));
    case 'addr': {
      const raw = word(value, type);
      if (raw >> 160n !== 0n) throw new ProtocolError('Arkiv addr value overflows');
      return `0x${value.slice(-40).toLowerCase()}`;
    }
    case 'key':
      word(value, type);
      return value.toLowerCase();
    case 'str':
      return new TextDecoder('utf-8', { fatal: true }).decode(fromHex(value));
    case 'bytes':
      return value.toLowerCase();
  }
}

/** Decodes the calldata of a transaction sent to {@link ARKIV_ENGINE_ADDRESS}. */
export function decodeExecute(data: Hex): DecodedExecute {
  let ops: readonly { operation: number; operationData: Hex }[];
  try {
    const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data });
    ops = decoded.args[0];
  } catch {
    throw new ProtocolError('transaction data is not an Arkiv execute() call');
  }

  const creates: DecodedCreate[] = [];
  for (const op of ops) {
    if (op.operation !== ARKIV_OPERATION.create) continue;
    let payload;
    try {
      [payload] = decodeAbiParameters(CREATE_PARAMS, op.operationData);
    } catch {
      throw new ProtocolError('Arkiv create operation is malformed');
    }
    const attributes = new Map<string, PlainAttribute>();
    for (const attribute of payload.attributes) {
      const type = TYPE_TAGS[attribute.typeId & ~INDEXED_FLAG];
      if (!type) throw new ProtocolError(`Arkiv attribute has unknown type id ${attribute.typeId}`);
      const name = attributeName(attribute.name);
      if (attributes.has(name)) throw new ProtocolError(`Arkiv attribute "${name}" appears twice`);
      attributes.set(name, {
        type,
        indexed: (attribute.typeId & INDEXED_FLAG) !== 0,
        value: decodePlainValue(type, attribute.value),
      });
    }
    creates.push({
      salt: payload.salt,
      expiresAt: payload.expiresAt,
      minLifetime: payload.minLifetime,
      readonly: (payload.creationFlags & READONLY_FLAG) !== 0,
      permissionlessExtension: (payload.creationFlags & PERMISSIONLESS_EXTENSION_FLAG) !== 0,
      attributes,
    });
  }
  return { operations: ops.map((op) => op.operation), creates };
}

/**
 * The plain form of a value built with the SDK's typed constructors (`str(...)`, `u64(...)`,
 * ...), so "what the gateway put in the transaction" and "what the device expected" compare
 * with `===`.
 */
export function plainValue(value: { type: string; value: unknown }): PlainAttribute['value'] {
  switch (value.type) {
    case 'bool':
      return value.value as boolean;
    case 'i32':
      return Number(value.value);
    case 'u64':
    case 'u256':
      return BigInt(value.value as bigint);
    case 'str':
      return value.value as string;
    case 'addr':
    case 'key':
    case 'bytes':
      return (value.value as string).toLowerCase();
    default:
      throw new ProtocolError(`cannot compare Arkiv values of type ${value.type}`);
  }
}
