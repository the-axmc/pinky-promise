/**
 * Byte helpers for the fixed-width wire formats. Every multi-byte integer in the protocol is
 * big-endian, and every helper here rejects out-of-range input instead of truncating it, so a
 * value that does not fit can never be signed by accident.
 */

export type Hex = `0x${string}`;

const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

export function toHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out as Hex;
}

/** Parses 0x-prefixed hex. With `length`, the byte count must match exactly. */
export function fromHex(hex: string, length?: number): Uint8Array {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) {
    throw new ProtocolError(`not 0x-prefixed hex: ${String(hex).slice(0, 24)}`);
  }
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  if (length !== undefined && out.length !== length) {
    throw new ProtocolError(`expected ${length} bytes, got ${out.length}`);
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function u8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new ProtocolError(`not a u8: ${value}`);
  return Uint8Array.of(value);
}

export function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new ProtocolError(`not a u32: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function i32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new ProtocolError(`not an i32: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

/** Encodes a non-negative safe integer as 8 big-endian bytes. */
export function u64be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolError(`not a u64-safe integer: ${value}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

export function readU8(bytes: Uint8Array, offset: number): number {
  return view(bytes, offset, 1).getUint8(0);
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return view(bytes, offset, 4).getUint32(0);
}

export function readI32(bytes: Uint8Array, offset: number): number {
  return view(bytes, offset, 4).getInt32(0);
}

/** Reads a u64 that must fit a JavaScript safe integer (true for every timestamp and counter). */
export function readU64(bytes: Uint8Array, offset: number): number {
  const value = view(bytes, offset, 8).getBigUint64(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolError(`u64 too large: ${value}`);
  return Number(value);
}

function view(bytes: Uint8Array, offset: number, length: number): DataView {
  if (offset < 0 || offset + length > bytes.length) {
    throw new ProtocolError(`read of ${length} bytes at ${offset} is outside ${bytes.length} bytes`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

/**
 * A short ASCII identifier (lot id, venue id) as a fixed-width field: the characters, then zero
 * bytes. Restricted to `A-Z a-z 0-9 . _ -` so the same value is a valid Arkiv string attribute,
 * a Solidity `bytes32` and something a human can read off a label.
 */
export function asciiFixed(text: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new ProtocolError(`identifier may only use A-Z a-z 0-9 . _ - : "${text}"`);
  }
  if (text.length > length) throw new ProtocolError(`identifier longer than ${length} bytes: "${text}"`);
  const out = new Uint8Array(length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

export function readAsciiFixed(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  let text = '';
  for (let i = 0; i < end; i++) text += String.fromCharCode(bytes[i]!);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new ProtocolError('identifier field is not clean ASCII');
  return text;
}

/** Any malformed, out-of-range or unverifiable protocol input. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
