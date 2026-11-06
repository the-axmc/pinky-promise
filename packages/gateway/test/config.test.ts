import { describe, expect, it } from 'vitest';
import { publicArkivRpcUrl } from '../src/assemble';
import { ConfigError, readConfig } from '../src/config';

const KEY = (byte: string) => `0x${byte.repeat(32)}`;
const complete = {
  ADMIN_TOKEN: 'a-long-enough-admin-token',
  REGISTRY_KEY: KEY('11'),
  GATEWAY_KEY: KEY('22'),
  ATTESTOR_KEY: KEY('33'),
  HEDERA_ORACLE: `0x${'aa'.repeat(20)}`,
  HEDERA_MARKET: `0x${'bb'.repeat(20)}`,
  HEDERA_ISSUER_KEY: KEY('44'),
  HEDERA_RELAYER_KEY: KEY('55'),
  HEDERA_INSPECTOR_KEY: KEY('66'),
  ZG_API_KEY: 'sk-test',
  ZG_MODEL: 'some-vision-model',
  ZG_STORAGE_KEY: KEY('77'),
};

describe('gateway configuration', () => {
  it('fills in the public testnet endpoints and the ATS addresses', () => {
    const config = readConfig(complete);
    expect(config.port).toBe(8787);
    expect(config.hedera).toMatchObject({
      rpcUrl: 'https://testnet.hashio.io/api',
      chainId: 296,
      factory: '0xd1F118A40f3b02883D35909eF2517e7EDd78379d',
      explorerUrl: 'https://hashscan.io/testnet',
    });
    expect(config.zg).toMatchObject({ routerUrl: 'https://router-api.0g.ai/v1', model: 'some-vision-model', verifyTee: false });
    expect(config.arkiv).toEqual({});
    expect(config.geofenceProofs).toBe(true);
    expect(config.demo).toBe(false);
    expect(config.dataDir).toMatch(/\.data\/gateway$/);
  });

  it('names every missing or malformed value at once', () => {
    const { ZG_API_KEY: _key, HEDERA_ORACLE: _oracle, ...rest } = complete;
    const error = (() => {
      try {
        readConfig({ ...rest, REGISTRY_KEY: '0x1234', ADMIN_TOKEN: 'short' });
      } catch (caught) {
        return caught as ConfigError;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error!.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ZG_API_KEY is not set/),
        expect.stringMatching(/^HEDERA_ORACLE is not set/),
        expect.stringMatching(/^REGISTRY_KEY must be a private key/),
        expect.stringMatching(/^ADMIN_TOKEN use at least 16 characters/),
      ]),
    );
  });

  it('treats an empty value as not set, as a copied .env.example leaves them', () => {
    expect(readConfig({ ...complete, ARKIV_RPC_URL: '', HEDERA_RPC_URL: '', ADMIN_TOKEN: '' })).toMatchObject({
      hedera: { rpcUrl: 'https://testnet.hashio.io/api' },
    });
    expect(() => readConfig({ ...complete, ZG_MODEL: '' })).toThrow(/ZG_MODEL is not set/);
  });

  it('lets a command ask for only the part it needs, keeping the defaults', () => {
    const config = readConfig({ HEDERA_ISSUER_KEY: KEY('44') }, ['HEDERA_ISSUER_KEY']);
    expect(config.hedera).toMatchObject({ rpcUrl: 'https://testnet.hashio.io/api', chainId: 296, issuerKey: KEY('44') });
    expect(() => readConfig({}, ['HEDERA_ISSUER_KEY'])).toThrow(/HEDERA_ISSUER_KEY is not set/);
  });

  it('never publishes the Arkiv access key to browsers', () => {
    const secret = 'my-secret-access-key-0123456789';
    const withKey = readConfig({ ...complete, ARKIV_ACCESS_KEY: secret });
    expect(publicArkivRpcUrl(withKey)).toMatch(/^https:\/\//);
    expect(publicArkivRpcUrl(withKey)).not.toContain(secret);
    // An operator can name the endpoint browsers should use; a custom node has no key to hide.
    expect(publicArkivRpcUrl(readConfig({ ...complete, ARKIV_ACCESS_KEY: secret, ARKIV_PUBLIC_RPC_URL: 'https://arkiv.example/rpc' }))).toBe('https://arkiv.example/rpc');
    expect(publicArkivRpcUrl(readConfig({ ...complete, ARKIV_RPC_URL: 'http://127.0.0.1:8645' }))).toBe('http://127.0.0.1:8645');
  });

  it('reads overrides and flags', () => {
    const config = readConfig({
      ...complete,
      PORT: '9000',
      GATEWAY_DEMO: 'true',
      GEOFENCE_PROOFS: 'false',
      ZG_VERIFY_TEE: '1',
      ARKIV_RPC_URL: 'http://127.0.0.1:8645',
      ARKIV_CHAIN_ID: '1337',
    });
    expect(config).toMatchObject({ port: 9000, demo: true, geofenceProofs: false, arkiv: { rpcUrl: 'http://127.0.0.1:8645', chainId: 1337 } });
    expect(config.zg.verifyTee).toBe(true);
  });
});
