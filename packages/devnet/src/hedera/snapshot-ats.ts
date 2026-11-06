/**
 * Builds an offline snapshot of the Asset Tokenization Studio (ATS) infrastructure that is
 * deployed on Hedera testnet: the runtime bytecode of the Factory, the Business Logic Resolver,
 * their proxies, all facets and the libraries they link to, plus the complete storage of the
 * stateful ones.
 *
 * The result is an "alloc" file (address -> { code, storage }) that a plain local EVM can be
 * started from, so tests and the local stack run the real ATS code without talking to Hedera.
 *
 * Source of truth is the public mirror node REST API, which — unlike the JSON-RPC relay — can
 * list every storage slot of a contract:
 *   GET /api/v1/contracts/{address}          -> runtime_bytecode
 *   GET /api/v1/contracts/{address}/state    -> all slots, paginated
 *
 * Usage: pnpm --filter @pinky/devnet snapshot:ats            (reuses what is already fetched)
 *        pnpm --filter @pinky/devnet snapshot:ats --refresh  (refetches everything)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIRROR = (process.env.HEDERA_MIRROR_URL ?? 'https://testnet.mirrornode.hedera.com').replace(/\/$/, '');
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/fixtures');
const ADDRESSES_FILE = resolve(FIXTURES, 'ats-hedera-testnet.addresses.json');
const OUT_FILE = resolve(FIXTURES, 'ats-hedera-testnet.alloc.json');
const CONCURRENCY = 4;

type Addresses = {
  infrastructure: {
    proxyAdmin: { address: string };
    blr: { implementation: string; proxy: string };
    factory: { implementation: string; proxy: string };
  };
  facets: { name: string; address: string }[];
};

type AllocAccount = { balance: string; nonce: string; code: string; storage: Record<string, string> };
type Alloc = Record<string, AllocAccount>;

/** GET a mirror node path. Returns null only for a definitive "not found". */
async function getJson(path: string): Promise<any | null> {
  const url = path.startsWith('http') ? path : `${MIRROR}${path}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.ok) return res.json();
    const body = await res.text();
    // A real "no such entity" is a JSON body with a _status block. The public mirror node also
    // occasionally answers a valid URL with a bare-text 404 or a 5xx and succeeds on the next
    // try, so anything else except a malformed request is retried.
    if (res.status === 404 && body.includes('"_status"')) return null;
    if (attempt >= 6 || res.status === 400) {
      throw new Error(`mirror node ${res.status} for ${url}: ${body.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
  }
}

/** Code and full storage of a contract, or null if the address is not a contract. */
async function fetchAccount(address: string): Promise<AllocAccount | null> {
  const info = await getJson(`/api/v1/contracts/${address}`);
  const code: string | undefined = info?.runtime_bytecode;
  if (!code || code === '0x') return null;

  const storage: Record<string, string> = {};
  let next: string | null = `/api/v1/contracts/${address}/state?limit=100&order=asc`;
  while (next) {
    const page: any = await getJson(next);
    for (const entry of page?.state ?? []) storage[entry.slot] = entry.value;
    next = page?.links?.next ?? null;
  }
  return { balance: '0x0', nonce: '0x1', code, storage };
}

/**
 * Addresses a contract's bytecode pushes onto the stack (PUSH20 operands). A linked external
 * library shows up this way, as do constants that are not contracts; the caller checks which
 * ones actually exist on chain. Walks opcodes properly so push data is never read as code.
 */
function pushedAddresses(code: string): string[] {
  const bytes = Buffer.from(code.slice(2), 'hex');
  const found = new Set<string>();
  for (let pc = 0; pc < bytes.length; pc++) {
    const op = bytes[pc]!;
    if (op >= 0x60 && op <= 0x7f) {
      const size = op - 0x5f;
      if (size === 20 && pc + 20 < bytes.length) {
        found.add('0x' + bytes.subarray(pc + 1, pc + 21).toString('hex'));
      }
      pc += size;
    }
  }
  return [...found];
}

/** Zero, precompile-range and all-ones addresses are never linked libraries. */
function isPlausibleContract(address: string): boolean {
  const value = BigInt(address);
  return value > 0xffffn && value !== (1n << 160n) - 1n;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const addresses = JSON.parse(readFileSync(ADDRESSES_FILE, 'utf8')) as Addresses;
  const { proxyAdmin, blr, factory } = addresses.infrastructure;

  const alloc: Alloc = !refresh && existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : {};
  const notContracts = new Set<string>();
  let queue = [
    proxyAdmin.address,
    blr.proxy,
    blr.implementation,
    factory.proxy,
    factory.implementation,
    ...addresses.facets.map((facet) => facet.address),
  ].map((a) => a.toLowerCase());

  console.log(`Snapshotting ATS from ${MIRROR} (${Object.keys(alloc).length} contracts already on disk)`);
  for (let round = 1; queue.length > 0; round++) {
    const missing = [...new Set(queue)].filter((a) => !alloc[a] && !notContracts.has(a));
    if (missing.length > 0) console.log(`  round ${round}: fetching ${missing.length} address(es)`);
    const fetched = await mapLimit(missing, CONCURRENCY, fetchAccount);
    missing.forEach((address, i) => {
      const account = fetched[i];
      if (!account) return void notContracts.add(address);
      alloc[address] = account;
      const slots = Object.keys(account.storage).length;
      if (round > 1 || slots > 0) {
        console.log(`    ${address}: ${(account.code.length - 2) / 2} bytes of code, ${slots} storage slots`);
      }
    });
    // Anything a contract in the snapshot can delegatecall into must be in the snapshot too.
    queue = Object.values(alloc)
      .flatMap((account) => pushedAddresses(account.code))
      .filter((a) => isPlausibleContract(a) && !alloc[a] && !notContracts.has(a));
  }

  const sorted: Alloc = Object.fromEntries(Object.entries(alloc).sort(([a], [b]) => a.localeCompare(b)));
  const json = JSON.stringify(sorted);
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(OUT_FILE, json + '\n');

  const accounts = Object.values(sorted);
  const totalSlots = accounts.reduce((sum, a) => sum + Object.keys(a.storage).length, 0);
  const totalCode = accounts.reduce((sum, a) => sum + (a.code.length - 2) / 2, 0);
  console.log(
    `Wrote ${OUT_FILE}\n  contracts: ${accounts.length}, code: ${totalCode} bytes, ` +
      `storage slots: ${totalSlots}, json: ${json.length} bytes`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
