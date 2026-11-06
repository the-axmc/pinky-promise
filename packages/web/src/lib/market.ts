/**
 * The buying side: listings on the receipt market, what a wallet holds and whether it may hold
 * the token at all, and the purchase itself. All reads are straight from the chain.
 */
import type { Address, Hex } from '@pinky/protocol';
import { atsTokenAbi, receiptMarketAbi } from '@pinky/protocol/hedera';
import { type Account, type EIP1193Provider, type WalletClient, createWalletClient, custom, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import type { Context } from './config';

export type Listing = { id: bigint; seller: Address; token: Address; unitsLeft: bigint; pricePerUnit: bigint };

export async function listingsFor(ctx: Context, token: Address): Promise<Listing[]> {
  const [ids, page] = await ctx.hedera.readContract({
    address: ctx.config.hedera.market,
    abi: receiptMarketAbi,
    functionName: 'getListings',
    args: [0n, 200n],
  });
  return page
    .map((listing, index) => ({ ...listing, id: ids[index]! }))
    .filter((listing) => listing.active && listing.unitsLeft > 0n && listing.token.toLowerCase() === token.toLowerCase())
    .map(({ id, seller, token: listed, unitsLeft, pricePerUnit }) => ({
      id,
      seller: seller.toLowerCase() as Address,
      token: listed.toLowerCase() as Address,
      unitsLeft,
      pricePerUnit,
    }));
}

export type Holding = { free: bigint; frozen: bigint; allowlisted: boolean; kyc: boolean };

export async function holdingOf(ctx: Context, token: Address, holder: Address): Promise<Holding> {
  const read = { address: token, abi: atsTokenAbi } as const;
  const [free, frozen, allowlisted, kycStatus] = await Promise.all([
    ctx.hedera.readContract({ ...read, functionName: 'balanceOf', args: [holder] }),
    ctx.hedera.readContract({ ...read, functionName: 'getFrozenTokens', args: [holder] }),
    ctx.hedera.readContract({ ...read, functionName: 'isInControlList', args: [holder] }),
    ctx.hedera.readContract({ ...read, functionName: 'getKycStatusFor', args: [holder] }),
  ]);
  return { free, frozen, allowlisted, kyc: Number(kycStatus) === 1 };
}

/**
 * What to send as the transaction's value. On Hedera a contract sees msg.value in tinybar
 * (8 decimals) while the JSON-RPC relay takes 18-decimal values, so the price is scaled up.
 */
export function paymentValue(chainId: number, cost: bigint): bigint {
  return [295, 296, 297].includes(chainId) ? cost * 10n ** 10n : cost;
}

/** The well-known anvil development mnemonic. Its keys are public: local chains only. */
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

/** The demo buyer the local stack funds and the demo allow-lists (anvil account #4). */
export function demoBuyer(ctx: Context): Account | undefined {
  if (!ctx.config.demo || ctx.config.hedera.chainId !== 31337) return undefined;
  return mnemonicToAccount(DEV_MNEMONIC, { addressIndex: 4 });
}

export type Buyer = { address: Address; wallet: WalletClient; kind: 'demo' | 'browser' };

export function demoWallet(ctx: Context): Buyer | undefined {
  const account = demoBuyer(ctx);
  if (!account) return undefined;
  return {
    address: account.address.toLowerCase() as Address,
    wallet: createWalletClient({ account, chain: ctx.hederaChain, transport: http() }),
    kind: 'demo',
  };
}

/** Connects the browser wallet (MetaMask or similar) and moves it to the lot's chain. */
export async function browserWallet(ctx: Context, provider: EIP1193Provider): Promise<Buyer> {
  const wallet = createWalletClient({ chain: ctx.hederaChain, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  if (!address) throw new Error('the wallet shared no account');
  try {
    await wallet.switchChain({ id: ctx.hederaChain.id });
  } catch {
    await wallet.addChain({ chain: ctx.hederaChain });
  }
  return { address: address.toLowerCase() as Address, wallet, kind: 'browser' };
}

/** Demo gateways let a visitor put their own wallet on the allowlist and pass KYC. */
export async function requestOnboarding(ctx: Context, assetId: string, address: Address): Promise<void> {
  const response = await fetch(`${ctx.gatewayUrl}/v1/demo/onboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assetId, address }),
  });
  if (!response.ok) throw new Error(`onboarding was refused (${response.status}): ${(await response.text()).slice(0, 200)}`);
}

/** Buys units from a listing. Resolves with the transaction hash once it is mined. */
export async function buy(ctx: Context, buyer: Buyer, listing: Listing, units: bigint): Promise<Hex> {
  const cost = units * listing.pricePerUnit;
  const call = {
    address: ctx.config.hedera.market,
    abi: receiptMarketAbi,
    functionName: 'buy',
    args: [listing.id, units],
    value: paymentValue(ctx.hederaChain.id, cost),
  } as const;
  // Simulate first: the compliance module's refusal (frozen lot, no KYC) surfaces as a reason.
  await ctx.hedera.simulateContract({ ...call, account: buyer.address });
  const hash = await buyer.wallet.writeContract({ ...call, account: buyer.wallet.account ?? buyer.address, chain: ctx.hederaChain });
  const receipt = await ctx.hedera.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`the purchase reverted (${hash})`);
  return hash;
}

/** Custom errors of the token and the market, by selector, in words a buyer can act on. */
const REFUSALS: Record<string, string> = {
  '0x66eb1b54': "The token refused the transfer: its compliance rules do not allow trading in the lot's current state (only while a venue holds the goods).",
};

/** Turns a failed purchase into one readable sentence. */
export function explainRefusal(error: unknown): string {
  const message = (error as { shortMessage?: string }).shortMessage ?? (error as Error).message ?? String(error);
  const selector = /0x[0-9a-f]{8}\b/i.exec(message)?.[0]?.toLowerCase();
  if (selector && REFUSALS[selector]) return REFUSALS[selector]!;
  return message.split('\n').slice(0, 3).join(' ');
}
