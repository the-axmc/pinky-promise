import { describe, expect, it } from 'vitest';
import { envValue, fillEnv } from '../src/testnet-keys';

describe('filling in .env', () => {
  it('fills an empty value', () => {
    expect(fillEnv('A=1\nREGISTRY_KEY=\nB=2\n', 'REGISTRY_KEY', '0xabc')).toBe(
      'A=1\nREGISTRY_KEY=0xabc\nB=2\n',
    );
  });

  it('never replaces a value that is there', () => {
    const text = 'REGISTRY_KEY=0xmine\n';
    expect(fillEnv(text, 'REGISTRY_KEY', '0xother')).toBe(text);
  });

  it('adds a variable the file does not have', () => {
    expect(fillEnv('A=1', 'SHOWCASE_DRIVE_KEY', 'k')).toBe('A=1\nSHOWCASE_DRIVE_KEY=k\n');
  });

  it('does not confuse a variable with one that ends the same way', () => {
    const text = 'HEDERA_ISSUER_KEY=0xset\nISSUER_KEY=\n';
    expect(envValue(text, 'ISSUER_KEY')).toBe('');
    expect(fillEnv(text, 'ISSUER_KEY', '0xnew')).toBe('HEDERA_ISSUER_KEY=0xset\nISSUER_KEY=0xnew\n');
  });
});
