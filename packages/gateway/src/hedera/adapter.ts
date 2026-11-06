/**
 * Everything the gateway does on Hedera, through the JSON-RPC relay (or the local stand-in):
 * issue the receipt token with Asset Tokenization Studio, configure its compliance, and drive
 * the custody oracle.
 *
 * Three keys, three roles:
 *   issuer     deploys the token and holds its administrative roles (issue, KYC, allowlist)
 *   relayer    pays to submit checkpoints; has no authority — the oracle checks signatures
 *   inspector  releases a lot after a breach has been inspected
 */
import {
  type Address,
  type Hex,
  type LotStateValue,
  type OutcomeValue,
  type Thresholds,
  assetIdToBytes32,
  sameAddress,
} from '@pinky/protocol';
import {
  atsFactoryAbi,
  atsResolverAbi,
  atsTokenAbi,
  ATS_EQUITY_CONFIG_ID,
  custodyOracleAbi,
  lotConfigArgs,
  receiptMarketAbi,
  receiptTokenArgs,
} from '@pinky/protocol/hedera';
import {
  type Account,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export type HederaConfig = {
  rpcUrl: string;
  chainId: number;
  /** ATS Factory and Business Logic Resolver. */
  factory: Address;
  resolver: Address;
  oracle: Address;
  market: Address;
  issuerKey: Hex;
  relayerKey: Hex;
  inspectorKey: Hex;
  /** Base URL of a block explorer for links (HashScan on testnet). */
  explorerUrl?: string;
  /** How often to poll for receipts. Hedera produces a block about every 2 s. */
  pollingIntervalMs?: number;
};

export type LotOnChain = {
  token: Address;
  device: Address;
  attestor: Address;
  inspector: Address;
  state: LotStateValue;
  breachOpen: boolean;
  lastSeq: number;
  clearedSeq: number;
};

export type AppliedCheckpoint = { txHash: Hex; outcome: OutcomeValue; stateAfter: LotStateValue };

/** Hedera bills at least 80 % of the gas limit, so limits stay close to the estimate. */
const GAS_HEADROOM_PERCENT = 125n;
/** Used only if the node cannot estimate. deployEquity was measured at ~6.7M gas. */
const FALLBACK_GAS = { deployEquity: 8_500_000n, default: 1_500_000n };

export class HederaAdapter {
  readonly config: HederaConfig;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly #wallets: Record<'issuer' | 'relayer' | 'inspector', WalletClient>;
  readonly #accounts: Record<'issuer' | 'relayer' | 'inspector', Account>;
  /** One transaction at a time per key, so nonces never collide. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(config: HederaConfig) {
    this.config = config;
    this.chain = defineChain({
      id: config.chainId,
      name: config.chainId === 296 ? 'Hedera Testnet' : `Hedera (chain ${config.chainId})`,
      nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    const transport = http(config.rpcUrl, { timeout: 60_000 });
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport,
      pollingInterval: config.pollingIntervalMs ?? 1_000,
    });
    this.#accounts = {
      issuer: privateKeyToAccount(config.issuerKey),
      relayer: privateKeyToAccount(config.relayerKey),
      inspector: privateKeyToAccount(config.inspectorKey),
    };
    this.#wallets = {
      issuer: createWalletClient({ chain: this.chain, transport, account: this.#accounts.issuer }),
      relayer: createWalletClient({ chain: this.chain, transport, account: this.#accounts.relayer }),
      inspector: createWalletClient({ chain: this.chain, transport, account: this.#accounts.inspector }),
    };
  }

  get issuer(): Address {
    return this.#accounts.issuer.address.toLowerCase() as Address;
  }

  get inspector(): Address {
    return this.#accounts.inspector.address.toLowerCase() as Address;
  }

  /** Simulates, sends with a gas limit close to the estimate, and waits for the receipt. */
  async #send(
    role: 'issuer' | 'relayer' | 'inspector',
    call: { address: Address; abi: any; functionName: string; args: readonly unknown[]; value?: bigint },
    fallbackGas = FALLBACK_GAS.default,
  ): Promise<TransactionReceipt> {
    const run = async () => {
      const account = this.#accounts[role];
      let gas: bigint;
      try {
        gas =
          ((await this.publicClient.estimateContractGas({ ...call, account })) * GAS_HEADROOM_PERCENT) / 100n;
      } catch (error) {
        // A revert is an answer, not an estimation problem: surface it instead of paying for it.
        const message = (error as Error).message ?? '';
        if (/revert|execution reverted|custom error/i.test(message)) throw error;
        gas = fallbackGas;
      }
      const hash = await this.#wallets[role].writeContract({ ...call, account, chain: this.chain, gas });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success')
        throw new Error(`Hedera transaction ${hash} reverted (${call.functionName})`);
      return receipt;
    };
    const previous = this.#queues.get(role) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.#queues.set(
      role,
      next.catch(() => {}),
    );
    return next;
  }

  // -------------------------------------------------------------------------------------------
  // Token lifecycle (issuer)
  // -------------------------------------------------------------------------------------------

  /** Deploys the lot's warehouse-receipt security token through the ATS Factory. */
  async deployReceiptToken(input: { assetId: string; units: number; unitValueCents: number }): Promise<{
    token: Address;
    txHash: Hex;
  }> {
    const configVersion = await this.publicClient.readContract({
      address: this.config.resolver,
      abi: atsResolverAbi,
      functionName: 'getLatestVersionByConfiguration',
      args: [ATS_EQUITY_CONFIG_ID],
    });
    const args = receiptTokenArgs({
      assetId: input.assetId,
      resolver: this.config.resolver,
      configVersion,
      issuer: this.issuer,
      oracle: this.config.oracle,
      units: BigInt(input.units),
      unitValueCents: BigInt(input.unitValueCents),
    });
    const receipt = await this.#send(
      'issuer',
      { address: this.config.factory, abi: atsFactoryAbi, functionName: 'deployEquity', args },
      FALLBACK_GAS.deployEquity,
    );
    const [deployed] = parseEventLogs({
      abi: atsFactoryAbi,
      eventName: 'EquityDeployed',
      logs: receipt.logs,
    });
    if (!deployed) throw new Error('ATS Factory did not emit EquityDeployed');
    const token = deployed.args.equityAddress.toLowerCase() as Address;

    // The issuer is its own KYC credential issuer; registering it once makes grantKyc usable.
    await this.#send('issuer', {
      address: token,
      abi: atsTokenAbi,
      functionName: 'addIssuer',
      args: [this.issuer],
    });
    return { token, txHash: receipt.transactionHash };
  }

  /** Binds the lot to its token, device, attestor and inspector in the custody oracle. */
  async registerLot(input: {
    assetId: string;
    token: Address;
    device: Address;
    attestor: Address;
    thresholds: Thresholds;
  }): Promise<Hex> {
    const receipt = await this.#send('issuer', {
      address: this.config.oracle,
      abi: custodyOracleAbi,
      functionName: 'registerLot',
      args: [lotConfigArgs({ ...input, inspector: this.inspector })],
    });
    return receipt.transactionHash;
  }

  /** Allowlists and KYCs an investor. Safe to call again for someone already onboarded. */
  async onboardInvestor(token: Address, investor: Address): Promise<void> {
    const read = { address: token, abi: atsTokenAbi } as const;
    if (
      !(await this.publicClient.readContract({ ...read, functionName: 'isInControlList', args: [investor] }))
    ) {
      await this.#send('issuer', { ...read, functionName: 'addToControlList', args: [investor] });
    }
    if (
      (await this.publicClient.readContract({
        ...read,
        functionName: 'getKycStatusFor',
        args: [investor],
      })) !== 1
    ) {
      const block = await this.publicClient.getBlock();
      const validFrom = block.timestamp - 60n;
      const validTo = block.timestamp + 365n * 86_400n;
      await this.#send('issuer', {
        ...read,
        functionName: 'grantKyc',
        args: [investor, `vc:pinky:${investor}`, validFrom, validTo, this.issuer],
      });
    }
  }

  /** Allowlists a contract that moves units on holders' behalf (the market). No KYC needed. */
  async allowlistSpender(token: Address, spender: Address): Promise<void> {
    const read = { address: token, abi: atsTokenAbi } as const;
    if (
      !(await this.publicClient.readContract({ ...read, functionName: 'isInControlList', args: [spender] }))
    ) {
      await this.#send('issuer', { ...read, functionName: 'addToControlList', args: [spender] });
    }
  }

  /** Issues units to an onboarded holder. The oracle only allows this while IN_CUSTODY. */
  async issue(token: Address, to: Address, units: number): Promise<Hex> {
    const receipt = await this.#send('issuer', {
      address: token,
      abi: atsTokenAbi,
      functionName: 'issue',
      args: [to, BigInt(units), '0x'],
    });
    return receipt.transactionHash;
  }

  // -------------------------------------------------------------------------------------------
  // Custody oracle
  // -------------------------------------------------------------------------------------------

  async lot(assetId: string): Promise<LotOnChain | undefined> {
    const lot = await this.publicClient.readContract({
      address: this.config.oracle,
      abi: custodyOracleAbi,
      functionName: 'getLot',
      args: [assetIdToBytes32(assetId)],
    });
    if (lot.state === 0) return undefined;
    return {
      token: lot.token.toLowerCase() as Address,
      device: lot.device.toLowerCase() as Address,
      attestor: lot.attestor.toLowerCase() as Address,
      inspector: lot.inspector.toLowerCase() as Address,
      state: lot.state as LotStateValue,
      breachOpen: lot.breachOpen,
      lastSeq: Number(lot.lastSeq),
      clearedSeq: Number(lot.clearedSeq),
    };
  }

  /**
   * Submits a decided checkpoint. Anyone could; the relayer just pays. The oracle verifies the
   * device's and the attestor's signatures and, for a freeze, the breach reading.
   */
  async submitCheckpoint(input: {
    checkpoint: Hex;
    deviceSig: Hex;
    attestation: Hex;
    attestorSig: Hex;
    breachReading?: { payload: Hex; sig: Hex };
  }): Promise<AppliedCheckpoint> {
    const receipt = await this.#send('relayer', {
      address: this.config.oracle,
      abi: custodyOracleAbi,
      functionName: 'submitCheckpoint',
      args: [
        input.checkpoint,
        input.deviceSig,
        input.attestation,
        input.attestorSig,
        input.breachReading?.payload ?? '0x',
        input.breachReading?.sig ?? '0x',
      ],
    });
    const [applied] = parseEventLogs({
      abi: custodyOracleAbi,
      eventName: 'CheckpointApplied',
      logs: receipt.logs,
    });
    if (!applied) throw new Error('oracle did not emit CheckpointApplied');
    return {
      txHash: receipt.transactionHash,
      outcome: applied.args.outcome as OutcomeValue,
      stateAfter: applied.args.stateAfter as LotStateValue,
    };
  }

  /** The inspector clears a breach: units unfreeze and the lot is back in custody. */
  async release(assetId: string, inspectionRef: Hex, clearedThroughSeq: number): Promise<Hex> {
    const receipt = await this.#send('inspector', {
      address: this.config.oracle,
      abi: custodyOracleAbi,
      functionName: 'release',
      args: [assetIdToBytes32(assetId), inspectionRef, BigInt(clearedThroughSeq)],
    });
    return receipt.transactionHash;
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  async holding(token: Address, holder: Address): Promise<{ free: bigint; frozen: bigint; total: bigint }> {
    const read = { address: token, abi: atsTokenAbi } as const;
    const [free, frozen, total] = await Promise.all([
      this.publicClient.readContract({ ...read, functionName: 'balanceOf', args: [holder] }),
      this.publicClient.readContract({ ...read, functionName: 'getFrozenTokens', args: [holder] }),
      this.publicClient.readContract({ ...read, functionName: 'getTotalBalanceFor', args: [holder] }),
    ]);
    return { free, frozen, total };
  }

  async totalSupply(token: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: token, abi: atsTokenAbi, functionName: 'totalSupply' });
  }

  /** Whether an address administers a token (used to sanity-check configuration). */
  async isTokenAdmin(token: Address, account: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: token,
      abi: atsTokenAbi,
      functionName: 'hasRole',
      args: [`0x${'00'.repeat(32)}`, account],
    });
  }

  explorerLink(kind: 'transaction' | 'contract' | 'account', id: string): string | undefined {
    return this.config.explorerUrl ? `${this.config.explorerUrl}/${kind}/${id}` : undefined;
  }
}

export { receiptMarketAbi, sameAddress };
