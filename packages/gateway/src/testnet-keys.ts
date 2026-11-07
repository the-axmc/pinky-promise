/**
 * `pnpm testnet:keys` — fills in the parts of `.env` a machine can make: fresh keys, the admin
 * token and the drive key. It creates `.env` from `.env.example` if there is none, and then prints
 * which address to fund where. It only fills empty values, so it is safe to run again: it then
 * just prints the addresses. Private keys are never printed.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENV_PATH = resolve(REPO_ROOT, '.env');
const EXAMPLE_PATH = resolve(REPO_ROOT, '.env.example');

const HEDERA_FAUCET = 'https://portal.hedera.com/faucet';
const ARKIV_FAUCET = 'https://hub.arkiv.network';
const ZG_FAUCET = 'https://faucet.0g.ai';

/** The keys, and who needs funding where. */
const KEYS: Array<{ name: string; role: string; fund?: { network: string; where: string } }> = [
  { name: 'REGISTRY_KEY', role: 'Arkiv registry', fund: { network: 'Arkiv', where: ARKIV_FAUCET } },
  { name: 'GATEWAY_KEY', role: 'Arkiv proof writer', fund: { network: 'Arkiv', where: ARKIV_FAUCET } },
  { name: 'ATTESTOR_KEY', role: 'decision attestor (needs no funds)' },
  { name: 'HEDERA_ISSUER_KEY', role: 'Hedera issuer', fund: { network: 'Hedera', where: HEDERA_FAUCET } },
  { name: 'HEDERA_RELAYER_KEY', role: 'Hedera relayer', fund: { network: 'Hedera', where: HEDERA_FAUCET } },
  {
    name: 'HEDERA_INSPECTOR_KEY',
    role: 'Hedera inspector',
    fund: { network: 'Hedera', where: HEDERA_FAUCET },
  },
  { name: 'ZG_STORAGE_KEY', role: '0G Storage payer', fund: { network: '0G', where: ZG_FAUCET } },
];

/** Reads one variable's value out of env-file text. Undefined when the line is not there. */
export function envValue(text: string, name: string): string | undefined {
  return new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim();
}

/** Sets a variable if it is empty or missing. A value already there is never replaced. */
export function fillEnv(text: string, name: string, value: string): string {
  const current = envValue(text, name);
  if (current) return text;
  if (current === undefined) return `${text.trimEnd()}\n${name}=${value}\n`;
  return text.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`);
}

function main(): void {
  const created = !existsSync(ENV_PATH);
  let text = readFileSync(created ? EXAMPLE_PATH : ENV_PATH, 'utf8');
  const before = text;

  for (const { name } of KEYS) text = fillEnv(text, name, generatePrivateKey());
  text = fillEnv(text, 'ADMIN_TOKEN', randomBytes(24).toString('hex'));
  text = fillEnv(text, 'SHOWCASE_DRIVE_KEY', randomBytes(16).toString('hex'));
  text = fillEnv(text, 'ZG_MODEL', 'qwen2.5-vl-72b-instruct');
  // A hosted demo needs self-service onboarding and view keys; the template's default is off.
  if (envValue(text, 'GATEWAY_DEMO') === 'false')
    text = text.replace(/^GATEWAY_DEMO=.*$/m, 'GATEWAY_DEMO=true');

  if (created || text !== before) {
    writeFileSync(ENV_PATH, text, { mode: 0o600 });
    chmodSync(ENV_PATH, 0o600);
    console.log(`${created ? 'created' : 'filled in'} .env (private keys are in that file only)\n`);
  } else console.log('.env already has its keys: nothing changed\n');

  console.log('Fund these addresses:\n');
  for (const network of ['Arkiv', 'Hedera', '0G']) {
    const rows = KEYS.filter((key) => key.fund?.network === network);
    console.log(`  ${network} — ${rows[0]!.fund!.where}`);
    for (const row of rows) {
      const account = privateKeyToAccount(envValue(text, row.name) as `0x${string}`);
      console.log(`    ${account.address}  ${row.role}`);
    }
    console.log('');
  }
  if (!envValue(text, 'ZG_API_KEY')) console.log('Still needed: ZG_API_KEY, from https://pc.0g.ai\n');
  console.log('Then: pnpm doctor, and pnpm deploy:hedera. docs/showcase.md section C has the rest.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
