/**
 * Tokens of the Arkiv query language (docs.arkiv.network/reference/query-language).
 *
 * Three things make the lexer less obvious than it looks:
 * - attribute names may contain `.` and `-`;
 * - `--` starts a comment that runs to the end of the line (which is why a name may not contain
 *   `--`);
 * - a typed literal such as `dec(4.5)` or `str('it''s')` is read as one token, wrapper and
 *   content together, because the content follows the wrapper's rules rather than the
 *   language's: `4.5` is only a number inside `dec(…)`.
 */
import { PARSE, queryError } from './errors';

export type Token =
  | { kind: 'word'; text: string; pos: number } // a name, keyword or type tag — the parser decides
  | { kind: 'number'; text: string; pos: number } // a bare whole number: 12, -7
  | { kind: 'hex'; text: string; pos: number } // a bare 0x… (always an error: hex carries a type)
  | { kind: 'string'; pos: number } // a bare quoted string (always an error: write str('…'))
  | { kind: 'typed'; tag: string; content: string; pos: number; contentPos: number } // tag(content)
  | { kind: 'symbol'; text: string; pos: number } // = < <= > >= != ( ) : *
  | { kind: 'end'; pos: number };

/** Words that open a typed literal when a parenthesis follows. `bytes` is listed to reject it. */
const WRAPPERS = new Set(['bool', 'i32', 'u64', 'u256', 'dec', 'str', 'addr', 'key', 'bytes32', 'bytes']);

const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string) => c >= '0' && c <= '9';
const isHexDigit = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isNameChar = (c: string) => isLetter(c) || isDigit(c) || c === '.' || c === '_' || c === '-';
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  /** Skips a quoted string starting at `from` (which is a quote); returns the index after it. */
  function skipString(from: number, errorPos: number): number {
    let j = from + 1;
    for (;;) {
      if (j >= input.length) throw queryError(PARSE, "unterminated string — expected a closing '", errorPos);
      if (input[j] === "'") {
        // A doubled quote is a quote inside the string; the language has no backslash escapes.
        if (input[j + 1] === "'") {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
  }

  while (i < input.length) {
    const c = input[i]!;

    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '-' && input[i + 1] === '-') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }

    const start = i;

    if (c === '0' && (input[i + 1] === 'x' || input[i + 1] === 'X')) {
      i += 2;
      while (i < input.length && isHexDigit(input[i]!)) i++;
      tokens.push({ kind: 'hex', text: input.slice(start, i), pos: start });
      continue;
    }

    if (isDigit(c) || ((c === '-' || c === '+') && isDigit(input[i + 1] ?? ''))) {
      i++;
      while (i < input.length && isDigit(input[i]!)) i++;
      tokens.push({ kind: 'number', text: input.slice(start, i), pos: start });
      continue;
    }

    if (isLetter(c) || c === '$') {
      i++;
      // A name runs over letters, digits, `.`, `_` and `-`, but stops where a comment begins.
      while (i < input.length && isNameChar(input[i]!) && !(input[i] === '-' && input[i + 1] === '-')) i++;
      const text = input.slice(start, i);

      if (WRAPPERS.has(text.toLowerCase()) && input[i] === '(') {
        // A typed literal: everything up to the matching parenthesis is its content.
        let j = i + 1;
        while (isSpace(input[j])) j++;
        const contentPos = j;
        if (input[j] === "'") j = skipString(j, start);
        while (j < input.length && input[j] !== ')') j++;
        if (j >= input.length) {
          throw queryError(PARSE, "unterminated typed literal — expected a closing ')'", start);
        }
        tokens.push({
          kind: 'typed',
          tag: text.toLowerCase(),
          content: input.slice(contentPos, j).trimEnd(),
          pos: start,
          contentPos,
        });
        i = j + 1;
        continue;
      }

      tokens.push({ kind: 'word', text, pos: start });
      continue;
    }

    if (c === "'") {
      i = skipString(i, start);
      tokens.push({ kind: 'string', pos: start });
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=') {
      tokens.push({ kind: 'symbol', text: two, pos: start });
      i += 2;
      continue;
    }
    if ('=<>():*'.includes(c)) {
      tokens.push({ kind: 'symbol', text: c, pos: start });
      i++;
      continue;
    }

    throw queryError(PARSE, 'unexpected character', start);
  }

  tokens.push({ kind: 'end', pos: input.length });
  return tokens;
}
