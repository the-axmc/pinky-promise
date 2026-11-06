/**
 * A local stand-in for Hedera testnet: an anvil chain loaded with the snapshot of the real Asset
 * Tokenization Studio contracts, plus freshly deployed CustodyOracle and ReceiptMarket.
 *
 * The gateway talks to it through the same JSON-RPC calls it sends to Hedera, so local runs
 * exercise the genuine ATS Factory and token code. What it does not reproduce is Hedera itself:
 * fees, HBAR units (tinybar vs. wei), HashScan, the mirror node and native services such as HCS.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATS_HEDERA_TESTNET,
  custodyOracleAbi,
  custodyOracleBytecode,
  receiptMarketAbi,
  receiptMarketBytecode,
} from '@pinky/protocol/hedera';
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { type AnvilInstance, type AnvilOptions, rpcBatch, startAnvil } from '../anvil';

const ALLOC_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/fixtures/ats-hedera-testnet.alloc.json',
);

/** anvil's well-known development mnemonic. These accounts exist, funded, on every anvil chain. */
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

const ROLES = ['issuer', 'relayer', 'inspector', 'depositor', 'buyer', 'outsider'] as const;
export type HederaRole = (typeof ROLES)[number];

export type HederaDevnet = {
  rpcUrl: string;
  chainId: number;
  factory: Address;
  resolver: Address;
  oracle: Address;
  market: Address;
  /** Funded development accounts, one per role in the demo. Never use these keys elsewhere. */
  accounts: Record<HederaRole, { address: Address; privateKey: Hex }>;
  stop(): Promise<void>;
};

type AllocAccount = { code: string; nonce: string; storage: Record<string, string> };

/** Writes the ATS snapshot (120 contracts, ~11.8k storage slots) into a running anvil. */
export async function loadAtsSnapshot(rpcUrl: string): Promise<void> {
  const alloc = JSON.parse(readFileSync(ALLOC_FILE, 'utf8')) as Record<string, AllocAccount>;
  const calls: Array<{ method: string; params: unknown[] }> = [];
  for (const [address, account] of Object.entries(alloc)) {
    calls.push({ method: 'anvil_setCode', params: [address, account.code] });
    calls.push({ method: 'anvil_setNonce', params: [address, account.nonce] });
    for (const [slot, value] of Object.entries(account.storage)) {
      calls.push({ method: 'anvil_setStorageAt', params: [address, slot, value] });
    }
  }
  for (let i = 0; i < calls.length; i += 1000) await rpcBatch(rpcUrl, calls.slice(i, i + 1000));
}

export function hederaDevChain(rpcUrl: string, chainId: number) {
  return defineChain({
    id: chainId,
    name: 'Hedera (local stand-in)',
    nativeCurrency: { name: 'Test HBAR', symbol: 'HBAR', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export async function startHederaDevnet(options: AnvilOptions = {}): Promise<HederaDevnet> {
  const anvil: AnvilInstance = await startAnvil({ chainId: 31337, ...options });
  try {
    await loadAtsSnapshot(anvil.url);

    const accounts = Object.fromEntries(
      ROLES.map((role, index) => {
        const account = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: index });
        const privateKey = `0x${Buffer.from(account.getHdKey().privateKey!).toString('hex')}` as Hex;
        return [role, { address: account.address, privateKey }];
      }),
    ) as HederaDevnet['accounts'];

    const chain = hederaDevChain(anvil.url, anvil.chainId);
    const publicClient = createPublicClient({ chain, transport: http() });
    const deployer = createWalletClient({
      chain,
      transport: http(),
      account: mnemonicToAccount(DEV_MNEMONIC, { addressIndex: 0 }),
    });

    const deploy = async (abi: any, bytecode: Hex): Promise<Address> => {
      const hash = await deployer.deployContract({ abi, bytecode });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error('contract deployment produced no address');
      return receipt.contractAddress;
    };
    const oracle = await deploy(custodyOracleAbi, custodyOracleBytecode);
    const market = await deploy(receiptMarketAbi, receiptMarketBytecode);

    return {
      rpcUrl: anvil.url,
      chainId: anvil.chainId,
      factory: ATS_HEDERA_TESTNET.factory,
      resolver: ATS_HEDERA_TESTNET.resolver,
      oracle,
      market,
      accounts,
      stop: anvil.stop,
    };
  } catch (error) {
    await anvil.stop();
    throw error;
  }
}
