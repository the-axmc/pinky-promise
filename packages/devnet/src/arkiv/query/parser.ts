/**
 * Parser for the Arkiv query language: a boolean expression over attributes, optionally followed
 * by `ORDER BY name:type ASC|DESC`.
 *
 *   query     := ( '*' | or ) [ ORDER BY name [ ':' type ] [ ASC | DESC ] ]
 *   or        := and ( OR and )*
 *   and       := unary ( AND unary )*
 *   unary     := NOT unary | primary
 *   primary   := '(' or ')'
 *              | EXISTS '(' name ')'
 *              | TYPEOF '(' name ')' '=' type
 *              | name ( '=' | '<' | '<=' | '>' | '>=' ) value
 *              | name BETWEEN value AND value
 *              | name STARTSWITH value
 *   value     := true | false | number | type '(' literal ')'
 *
 * Error codes, wording and positions follow what the Rabdi testnet answers for the same
 * mistakes, so that a query rejected here is rejected the same way there. Two things the real
 * node does that the docs do not mention are kept as well: `*` on its own matches every entity,
 * and `key` and `bytes32` are one type as far as comparisons go.
 */
import { hexToBytes, keccak256, stringToBytes } from 'viem';
import type { Comparable, TypeTag } from '../model';
import { INTERNAL, LITERAL, PARSE, RpcError, TYPE, queryError } from './errors';
import { type Token, tokenize } from './lexer';

export type ComparisonOperator = '=' | '<' | '<=' | '>' | '>=';

export type Condition =
  | { kind: 'all' }
  | { kind: 'comparison'; name: string; operator: ComparisonOperator; value: Comparable }
  | { kind: 'between'; name: string; low: Comparable; high: Comparable }
  | { kind: 'startsWith'; name: string; prefix: Uint8Array }
  | { kind: 'exists'; name: string }
  | { kind: 'typeOf'; name: string; tag: TypeTag }
  | { kind: 'and'; conditions: Condition[] }
  | { kind: 'or'; conditions: Condition[] };

export type OrderBy = { name: string; type: TypeTag; direction: 'asc' | 'desc' };

export type ParsedQuery = { where: Condition; orderBy: OrderBy | undefined };

/** The four entity fields a query may filter and sort on, each with a fixed type. */
export const SYSTEM_FIELD_TYPES: Readonly<Record<string, TypeTag>> = {
  $key: 'key',
  $owner: 'addr',
  $creator: 'addr',
  $expiresAt: 'u64',
};
/** Entity fields a query can return but neither filter nor sort on. */
const PROJECTION_ONLY = new Set(['$createdAt', '$updatedAt', '$creationFlags']);

/** The type tags a query can name. `bytes` is missing on purpose: it is never indexed. */
const TYPE_TAG_LIST = ['i32', 'u64', 'u256', 'dec', 'str', 'addr', 'key', 'bytes32', 'bool'] as const;
const QUERY_TYPE_TAGS = new Set<string>(TYPE_TAG_LIST);

const NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const COMPARISONS = new Set(['=', '<', '<=', '>', '>=']);
const I32_MIN = -(2n ** 31n);
const I32_MAX = 2n ** 31n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const U256_MAX = 2n ** 256n - 1n;
const INT256_MAX = 2n ** 255n - 1n;
const INT256_MIN = -(2n ** 255n);
const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const HEX_NEEDS_TYPE = 'a hex literal must carry its type — write addr(0x…), key(0x…), bytes32(0x…) or u256(0x…)';

/** `key` and `bytes32` are both a 32-byte value and the node compares them as one type. */
export function canonicalType(tag: TypeTag): TypeTag {
  return tag === 'bytes32' ? 'key' : tag;
}

export function parseQuery(input: string): ParsedQuery {
  return new Parser(tokenize(input)).parse();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ParsedQuery {
    const first = this.peek();
    if (first.kind === 'end') {
      throw queryError(PARSE, 'empty query — write a predicate, or * to match every entity', 0);
    }

    let where: Condition;
    if (this.isSymbol('*')) {
      this.next();
      where = { kind: 'all' };
      const after = this.peek();
      if (after.kind !== 'end' && !this.isKeyword('order')) {
        throw queryError(PARSE, '* matches every entity and cannot be combined with other predicates', after.pos);
      }
    } else {
      where = this.parseOr();
    }

    let orderBy: OrderBy | undefined;
    if (this.isKeyword('order') && this.isKeyword('by', 1)) {
      orderBy = this.parseOrderBy();
      const rest = this.peek();
      if (rest.kind !== 'end') {
        throw queryError(
          PARSE,
          'unexpected input after ORDER BY — it ends the query, and sorts by one attribute',
          rest.pos,
        );
      }
    }

    const rest = this.peek();
    if (rest.kind !== 'end') {
      if (rest.kind === 'symbol' && rest.text === '!=') throw notEqual(rest.pos);
      throw queryError(PARSE, 'expected AND, OR, ORDER BY or the end of the query', rest.pos);
    }
    return { where, orderBy };
  }

  // --- token helpers ---------------------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'end') this.index++;
    return token;
  }

  private isKeyword(keyword: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === 'word' && token.text.toLowerCase() === keyword;
  }

  private isSymbol(symbol: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === 'symbol' && token.text === symbol;
  }

  private expectSymbol(symbol: string): Token {
    const token = this.next();
    if (token.kind !== 'symbol' || token.text !== symbol) {
      throw queryError(PARSE, `expected ${symbol}`, token.pos);
    }
    return token;
  }

  // --- expressions -----------------------------------------------------------------------

  private parseOr(): Condition {
    const conditions = [this.parseAnd()];
    while (this.isKeyword('or')) {
      this.next();
      conditions.push(this.parseAnd());
    }
    return conditions.length === 1 ? conditions[0]! : { kind: 'or', conditions };
  }

  private parseAnd(): Condition {
    const conditions = [this.parseUnary()];
    while (this.isKeyword('and')) {
      this.next();
      conditions.push(this.parseUnary());
    }
    return conditions.length === 1 ? conditions[0]! : { kind: 'and', conditions };
  }

  private parseUnary(): Condition {
    if (this.isKeyword('not')) {
      this.next();
      // Parsed first, so a malformed operand is still reported as the parse error it is.
      this.parseUnary();
      // The language reserves NOT and the real node parses it, but its store answers
      // "NotImplemented". Mirrored here so a query that works locally also works on Rabdi.
      throw new RpcError(INTERNAL, 'query: store: NotImplemented');
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Condition {
    const token = this.peek();

    if (token.kind === 'symbol' && token.text === '(') {
      this.next();
      const inner = this.parseOr();
      this.expectSymbol(')');
      return inner;
    }

    if ((this.isKeyword('exists') || this.isKeyword('typeof')) && this.isSymbol('(', 1)) {
      const isExists = this.isKeyword('exists');
      this.next();
      this.next();
      const nameToken = this.peek();
      const name = this.parseName();
      if (name.startsWith('$')) {
        throw queryError(
          TYPE,
          `${name} is a system attribute, which every entity carries — exists and typeof take a user attribute`,
          nameToken.pos,
        );
      }
      this.expectSymbol(')');
      if (isExists) return { kind: 'exists', name };
      this.expectSymbol('=');
      return { kind: 'typeOf', name, tag: this.parseTypeTag() };
    }

    if (token.kind === 'end') throw queryError(PARSE, 'expected a predicate', token.pos);
    if (token.kind === 'symbol' && token.text === '*') {
      throw queryError(PARSE, '* matches every entity and cannot be combined with other predicates', token.pos);
    }
    // Anything else here has to be the attribute a condition is about.

    const name = this.parseName();
    const system = SYSTEM_FIELD_TYPES[name];
    const operator = this.next();

    if (operator.kind === 'word' && operator.text.toLowerCase() === 'between') {
      const lowToken = this.peek();
      const low = this.parseValue();
      const and = this.next();
      if (and.kind !== 'word' || and.text.toLowerCase() !== 'and') {
        throw queryError(PARSE, 'expected AND between the two BETWEEN bounds', and.pos);
      }
      const highToken = this.peek();
      const high = this.parseValue();
      if (canonicalType(low.type) !== canonicalType(high.type)) {
        throw queryError(
          TYPE,
          `BETWEEN bounds must be of one type, but they are ${low.type} and ${high.type}`,
          highToken.pos,
        );
      }
      assertSystemType(system, low.type, lowToken.pos);
      return { kind: 'between', name, low, high };
    }

    if (operator.kind === 'word' && operator.text.toLowerCase() === 'startswith') {
      const valueToken = this.peek();
      const value = this.parseValue();
      if (value.type !== 'str') {
        throw queryError(TYPE, "STARTSWITH matches a string prefix — write str('…')", valueToken.pos);
      }
      assertSystemType(system, 'str', valueToken.pos);
      return { kind: 'startsWith', name, prefix: value.bytes! };
    }

    if (operator.kind === 'symbol' && operator.text === '!=') throw notEqual(operator.pos);
    if (operator.kind !== 'symbol' || !COMPARISONS.has(operator.text)) {
      throw queryError(PARSE, 'expected a comparison operator (= < <= > >= BETWEEN STARTSWITH)', operator.pos);
    }
    const valueToken = this.peek();
    const value = this.parseValue();
    assertSystemType(system, value.type, valueToken.pos);
    return { kind: 'comparison', name, operator: operator.text as ComparisonOperator, value };
  }

  // --- names, types, values --------------------------------------------------------------

  /** An attribute name or one of the four queryable entity fields. */
  private parseName(): string {
    const token = this.next();
    if (token.kind !== 'word') throw queryError(PARSE, 'expected an attribute name', token.pos);
    const name = token.text;
    if (name.startsWith('$')) {
      if (SYSTEM_FIELD_TYPES[name] !== undefined) return name;
      if (PROJECTION_ONLY.has(name)) {
        throw queryError(TYPE, `${name} is not queryable — it is returned by projections only`, token.pos);
      }
      throw queryError(
        TYPE,
        `unknown system attribute ${name} — expected $key, $owner, $creator or $expiresAt`,
        token.pos,
      );
    }
    if (!NAME_RE.test(name) || name.length > 32) throw queryError(PARSE, 'expected an attribute name', token.pos);
    return name;
  }

  private parseTypeTag(): TypeTag {
    const token = this.next();
    const text = token.kind === 'word' ? token.text : token.kind === 'typed' ? token.tag : '';
    const tag = text.toLowerCase();
    if (!QUERY_TYPE_TAGS.has(tag)) {
      throw queryError(TYPE, `${text || 'that'} is not a type tag — one of ${TYPE_TAG_LIST.join(' ')}`, token.pos);
    }
    return tag as TypeTag;
  }

  private parseValue(): Comparable {
    const token = this.next();
    switch (token.kind) {
      case 'typed':
        return typedLiteral(token);
      case 'word': {
        const word = token.text.toLowerCase();
        if (word === 'true' || word === 'false') return { type: 'bool', num: word === 'true' ? 1n : 0n };
        throw queryError(PARSE, "expected a value — true, false, a number, or a typed literal such as str('…')", token.pos);
      }
      case 'number':
        // A bare number is an i32.
        return inRange('i32', BigInt(token.text), token.pos);
      case 'hex':
        throw queryError(PARSE, HEX_NEEDS_TYPE, token.pos);
      case 'string':
        throw queryError(PARSE, "a string literal must carry its type — write str('…')", token.pos);
      default:
        throw queryError(PARSE, 'expected a value', token.pos);
    }
  }

  private parseOrderBy(): OrderBy {
    this.next(); // ORDER
    this.next(); // BY
    const nameToken = this.peek();
    const name = this.parseName();
    const system = SYSTEM_FIELD_TYPES[name];

    let type: TypeTag | undefined;
    if (this.isSymbol(':')) {
      this.next();
      const typeToken = this.peek();
      type = this.parseTypeTag();
      if (system !== undefined && canonicalType(type) !== system) {
        throw queryError(TYPE, `${name} holds ${system}, so it sorts as ${system} — not as ${type}`, typeToken.pos);
      }
    }
    type ??= system;
    if (type === undefined) {
      throw queryError(
        TYPE,
        `${name} can hold any type, so ORDER BY names the one to sort it as — write ORDER BY ${name}:str, or another tag`,
        nameToken.pos,
      );
    }

    let direction: 'asc' | 'desc' = 'asc';
    if (this.isKeyword('asc') || this.isKeyword('desc')) {
      direction = (this.next() as Token & { kind: 'word' }).text.toLowerCase() as 'asc' | 'desc';
    }
    return { name, type, direction };
  }
}

function notEqual(position: number): RpcError {
  return queryError(
    TYPE,
    '!= is not part of the query language — write NOT (attr = value) for the complement',
    position,
  );
}

/** An entity field has one type; comparing it against another can never match. */
function assertSystemType(system: TypeTag | undefined, actual: TypeTag, position: number): void {
  if (system !== undefined && system !== canonicalType(actual)) {
    throw queryError(TYPE, `this system attribute holds ${system}, but the value is ${actual}`, position);
  }
}

function inRange(tag: 'i32' | 'u64' | 'u256', value: bigint, position: number): Comparable {
  if (tag === 'i32' && (value < I32_MIN || value > I32_MAX)) {
    throw queryError(
      LITERAL,
      'value is out of range for i32 [-2147483648, 2147483647] — use u256(…) for larger numbers',
      position,
    );
  }
  if (tag === 'u64' && value > U64_MAX) {
    throw queryError(LITERAL, 'value is out of range for u64 [0, 18446744073709551615]', position);
  }
  if (tag === 'u256' && value > U256_MAX) throw queryError(LITERAL, 'value is out of range for u256', position);
  return { type: tag, num: value };
}

/** Validates the content of a `tag(content)` literal. Positions point at the content. */
function typedLiteral(token: Token & { kind: 'typed' }): Comparable {
  const { tag, content, contentPos: at } = token;
  switch (tag) {
    case 'bool':
      throw queryError(LITERAL, 'bool takes no wrapper — write the literal true or false', at);
    case 'bytes':
      throw queryError(PARSE, HEX_NEEDS_TYPE, at);
    case 'i32':
      if (!/^[+-]?\d+$/.test(content)) throw queryError(LITERAL, 'i32 expects decimal digits', at);
      return inRange('i32', BigInt(content), at);
    case 'u64':
    case 'u256': {
      if (content.startsWith('-')) {
        throw queryError(LITERAL, `${tag} is unsigned — remove the sign, or use i32(…)`, at);
      }
      if (tag === 'u256' && /^0x[0-9a-fA-F]+$/.test(content)) return inRange('u256', BigInt(content), at);
      if (!/^\+?\d+$/.test(content)) throw queryError(LITERAL, `${tag} expects decimal digits`, at);
      return inRange(tag, BigInt(content), at);
    }
    case 'dec': {
      const match = DECIMAL_RE.exec(content);
      if (!match) throw queryError(LITERAL, 'dec expects decimal digits', at);
      const fraction = match[3] ?? '';
      if (fraction.length > 18) {
        throw queryError(LITERAL, `dec holds at most 18 decimal places, but this has ${fraction.length}`, at);
      }
      const digits = BigInt(match[2]! + fraction.padEnd(18, '0'));
      const units = match[1] === '-' ? -digits : digits;
      if (units > INT256_MAX || units < INT256_MIN) throw queryError(LITERAL, 'value is out of range for dec', at);
      return { type: 'dec', num: units };
    }
    case 'str': {
      const text = unquote(content);
      if (text === undefined) throw queryError(LITERAL, "str takes a single-quoted string, e.g. str('Bob')", at);
      return { type: 'str', bytes: stringToBytes(text) };
    }
    case 'addr': {
      if (!/^0x[0-9a-fA-F]{40}$/.test(content)) {
        throw queryError(LITERAL, 'an address is 0x followed by exactly 40 hex digits', at);
      }
      if (!hasValidChecksum(content)) {
        throw queryError(
          LITERAL,
          'address fails its EIP-55 checksum — fix the capitalization, or write it all-lowercase',
          at,
        );
      }
      return { type: 'addr', bytes: hexToBytes(content.toLowerCase() as `0x${string}`) };
    }
    default: {
      // key, bytes32
      if (!/^0x[0-9a-fA-F]{64}$/.test(content)) {
        throw queryError(LITERAL, 'expected 0x followed by exactly 64 hex digits', at);
      }
      return { type: tag as TypeTag, bytes: hexToBytes(content.toLowerCase() as `0x${string}`) };
    }
  }
}

/** `'it''s'` -> `it's`. Undefined unless the whole content is one quoted string. */
function unquote(content: string): string | undefined {
  if (content.length < 2 || !content.startsWith("'") || !content.endsWith("'")) return undefined;
  const inner = content.slice(1, -1);
  // Every quote inside must be half of a doubled pair.
  if (/'/.test(inner.replaceAll("''", ''))) return undefined;
  return inner.replaceAll("''", "'");
}

/** All-lowercase passes; anything with a capital must carry a correct EIP-55 checksum. */
function hasValidChecksum(address: string): boolean {
  const body = address.slice(2);
  if (body === body.toLowerCase()) return true;
  const hash = keccak256(stringToBytes(body.toLowerCase())).slice(2);
  for (let i = 0; i < 40; i++) {
    const char = body[i]!;
    if (/[a-fA-F]/.test(char)) {
      const shouldBeUpper = parseInt(hash[i]!, 16) >= 8;
      if ((char === char.toUpperCase()) !== shouldBeUpper) return false;
    }
  }
  return true;
}
