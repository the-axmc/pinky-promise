/**
 * Everything the gateway does on Arkiv, through the official SDK.
 *
 * Three wallets write, and who writes is the point:
 *   registry  Device, Venue and Lot entities (key held by the gateway operator)
 *   gateway   GeoProof entities (key held by the gateway)
 *   DEVICE    Reading and Checkpoint entities — the gateway holds no key for these. It builds
 *             the transaction with the SDK, and a custom viem account forwards the signing
 *             step to the device, which reviews the calldata before signing.
 *
 * Writes follow Arkiv's guidance for Rabdi: one transaction at a time per signer, with an
 * explicit latest nonce, gas limit and gas price.
 */
import { createPublicClient, createWalletClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import type { ChainAnchor, SignRequest, UnsignedTransaction } from '@pinky/device';
import { type Address, type Hex, concat, fromHex, sameAddress, secpRecover } from '@pinky/protocol';
import {
  type CheckpointInput,
  Checkpoints,
  Devices,
  ENTITY_FLAGS,
  type GeoProofInput,
  GeoProofs,
  type LotInput,
  Lots,
  type ReadingInput,
  Readings,
  Venues,
  checkpointValues,
  deviceValues,
  evidenceExpiration,
  geoProofValues,
  lotValues,
  readingValues,
  registryExpiration,
  shipmentExpiration,
  venueValues,
} from '@pinky/protocol/arkiv';
import type { Venue } from '@pinky/protocol';
import { type Chain, defineChain, http, keccak256, serializeTransaction } from 'viem';
import { privateKeyToAccount, toAccount } from 'viem/accounts';
import { getGasPrice } from 'viem/actions';
import { DeviceRefusedError, DeviceTimeoutError, type SignRequestQueue } from './sign-requests';

export type ArkivConfig = {
  /** Set for a local or custom node. Leave unset to use the Rabdi testnet. */
  rpcUrl?: string;
  chainId?: number;
  /** Rabdi access key (https://hub.arkiv.network/access-keys). Empty uses the rate-limited public endpoint. */
  accessKey?: string;
  registryKey: Hex;
  gatewayKey: Hex;
  /** How often to poll for receipts. Defaults to 1 s (blocks are 2 s apart). */
  pollingIntervalMs?: number;
  /**
   * Longest a single transaction may take from signing to receipt before it is given up on and
   * the worker retries. Bounded, because a transaction the node dropped would otherwise be
   * waited on forever. Default 3 minutes.
   */
  txTimeoutMs?: number;
};

/** Arkiv's recommended floor on Rabdi: 1,000,000 gas, plus 400,000 per extra operation. */
const GAS_FLOOR = 1_000_000n;
const GAS_PER_EXTRA_OPERATION = 400_000n;
/** Extra gas per byte of `bytes` payload (a geofence proof is about 9 KB). */
const GAS_PER_PAYLOAD_BYTE = 120n;
const BLOCK_TIME_MS = 2_000;

export type Lifetimes = { endsAt: number; disputeWindowS: number };

/**
 * The SDK wraps whatever goes wrong during a write in its own error. When the real cause is the
 * device declining or not answering, surface that: nothing was broadcast, and the caller needs
 * to tell "the device said no" from "the chain said no".
 */
function unwrapDeviceError(error: unknown): unknown {
  for (let cause: any = error; cause; cause = cause.cause) {
    if (cause instanceof DeviceRefusedError || cause instanceof DeviceTimeoutError) return cause;
  }
  return error;
}

export class ArkivAdapter {
  readonly chain: Chain;
  readonly reader: ReturnType<typeof createPublicClient>;
  readonly registry: Address;
  readonly gateway: Address;
  readonly #transport: ReturnType<typeof http>;
  readonly #pollingInterval: number;
  readonly #txTimeoutMs: number;
  readonly #registryWallet: ReturnType<typeof createWalletClient>;
  readonly #gatewayWallet: ReturnType<typeof createWalletClient>;
  readonly #deviceWallets = new Map<string, ReturnType<typeof createWalletClient>>();
  readonly #signRequests: SignRequestQueue;
  /** One transaction at a time per signer. */
  readonly #queues = new Map<string, Promise<unknown>>();
  #purpose: SignRequest['purpose'] = 'reading';

  constructor(config: ArkivConfig, signRequests: SignRequestQueue) {
    // The SDK's chain objects carry no block time, which makes viem poll every 4 s; set it.
    this.chain = config.rpcUrl
      ? defineChain({
          id: config.chainId ?? 1337,
          name: 'Arkiv (custom node)',
          nativeCurrency: { name: 'Golem', symbol: 'tGLM', decimals: 18 },
          rpcUrls: { default: { http: [config.rpcUrl] } },
          blockTime: BLOCK_TIME_MS,
          testnet: true,
        })
      : { ...rabdi({ accessKey: config.accessKey ?? '' }), blockTime: BLOCK_TIME_MS };
    this.#transport = http(undefined, { timeout: 30_000 });
    this.#pollingInterval = config.pollingIntervalMs ?? 1_000;
    this.#txTimeoutMs = config.txTimeoutMs ?? 180_000;
    this.reader = createPublicClient({
      chain: this.chain,
      transport: this.#transport,
      pollingInterval: this.#pollingInterval,
    });
    this.#signRequests = signRequests;

    const registry = privateKeyToAccount(config.registryKey);
    const gateway = privateKeyToAccount(config.gatewayKey);
    this.registry = registry.address.toLowerCase() as Address;
    this.gateway = gateway.address.toLowerCase() as Address;
    const pollingInterval = this.#pollingInterval;
    this.#registryWallet = createWalletClient({
      chain: this.chain,
      transport: this.#transport,
      account: registry,
      pollingInterval,
    });
    this.#gatewayWallet = createWalletClient({
      chain: this.chain,
      transport: this.#transport,
      account: gateway,
      pollingInterval,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Chain context
  // -------------------------------------------------------------------------------------------

  /** The latest block: its hash is the freshness anchor devices put in their payloads. */
  async anchor(): Promise<ChainAnchor> {
    const block = await this.reader.getBlock({ blockTag: 'latest' });
    return { blockNumber: Number(block.number), blockHash: block.hash as Hex };
  }

  /** The number of a block by hash, or undefined if this chain has no such block. */
  async blockNumberOf(blockHash: Hex): Promise<number | undefined> {
    try {
      return Number((await this.reader.getBlock({ blockHash })).number);
    } catch {
      return undefined;
    }
  }

  async balance(address: Address): Promise<bigint> {
    return this.reader.getBalance({ address });
  }

  /** Tops a device wallet up from the registry so it can pay for its own entities. */
  async ensureFunded(address: Address, minimumWei: bigint, topUpWei: bigint): Promise<Hex | undefined> {
    if ((await this.balance(address)) >= minimumWei) return undefined;
    return this.#serialized(this.registry, async () => {
      const hash = await this.#registryWallet.sendTransaction({
        account: this.#registryWallet.account!,
        chain: this.chain,
        to: address,
        value: topUpWei,
        gasPrice: await getGasPrice(this.reader),
        gas: 21_000n,
      });
      await this.reader.waitForTransactionReceipt({ hash });
      return hash;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Registry and gateway writes
  // -------------------------------------------------------------------------------------------

  createVenue(venue: Venue) {
    return this.#create(this.#registryWallet, this.registry, Venues, venueValues(venue), {
      expiration: registryExpiration(),
      flags: ENTITY_FLAGS.registry,
    });
  }

  createDevice(input: Parameters<typeof deviceValues>[0]) {
    return this.#create(this.#registryWallet, this.registry, Devices, deviceValues(input), {
      expiration: registryExpiration(),
      flags: ENTITY_FLAGS.registry,
    });
  }

  createLot(input: LotInput) {
    return this.#create(this.#registryWallet, this.registry, Lots, lotValues(input), {
      expiration: shipmentExpiration(input),
      flags: ENTITY_FLAGS.evidence,
    });
  }

  createGeoProof(input: GeoProofInput, lifetimes: Lifetimes) {
    return this.#create(
      this.#gatewayWallet,
      this.gateway,
      GeoProofs,
      geoProofValues(input),
      { expiration: evidenceExpiration(lifetimes.disputeWindowS), flags: ENTITY_FLAGS.evidence },
      BigInt(input.proof.length) * GAS_PER_PAYLOAD_BYTE,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Device-signed writes
  // -------------------------------------------------------------------------------------------

  /** Publishes readings in one transaction the device signs. Resolves with their entity keys. */
  async createReadings(
    device: Address,
    inputs: ReadingInput[],
    lifetimes: Lifetimes,
  ): Promise<{ txHash: Hex; entityKeys: Hex[] }> {
    if (inputs.length === 0) throw new Error('no readings to publish');
    const wallet = this.#deviceWallet(device);
    const expiration = shipmentExpiration(lifetimes);
    return this.#serialized(device, async () => {
      this.#purpose = 'reading';
      try {
        const result = await wallet.executeBatch(
          {
            creates: inputs.map((input) => ({
              schema: Readings,
              values: readingValues(input),
              expiration,
              flags: ENTITY_FLAGS.evidence,
            })),
          },
          await this.#txParams(device, inputs.length),
        );
        return { txHash: result.txHash as Hex, entityKeys: result.createdEntities as Hex[] };
      } catch (error) {
        throw unwrapDeviceError(error);
      }
    });
  }

  /** Publishes a checkpoint record (PENDING or decided) in a transaction the device signs. */
  async createCheckpoint(
    device: Address,
    input: CheckpointInput,
    lifetimes: Lifetimes,
  ): Promise<{ txHash: Hex; entityKey: Hex }> {
    const wallet = this.#deviceWallet(device);
    return this.#serialized(device, async () => {
      this.#purpose = 'checkpoint';
      const payloadBytes = BigInt((input.breachReading?.length ?? 0) / 2 + 1200);
      try {
        const result = await wallet.createEntity(
          Checkpoints,
          checkpointValues(input),
          { expiration: evidenceExpiration(lifetimes.disputeWindowS), flags: ENTITY_FLAGS.evidence },
          await this.#txParams(device, 1, payloadBytes * GAS_PER_PAYLOAD_BYTE),
        );
        return { txHash: result.txHash as Hex, entityKey: result.entityKey as Hex };
      } catch (error) {
        throw unwrapDeviceError(error);
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  async #create(
    wallet: ReturnType<typeof createWalletClient>,
    signer: Address,
    schema: any,
    values: any,
    options: any,
    extraGas = 0n,
  ): Promise<{ txHash: Hex; entityKey: Hex }> {
    return this.#serialized(signer, async () => {
      const result = await (wallet as any).createEntity(
        schema,
        values,
        options,
        await this.#txParams(signer, 1, extraGas),
      );
      return { txHash: result.txHash as Hex, entityKey: result.entityKey as Hex };
    });
  }

  /** Explicit latest nonce, gas and gas price, as Arkiv recommends for Rabdi. */
  async #txParams(signer: Address, operations: number, extraGas = 0n) {
    const [nonce, gasPrice] = await Promise.all([
      this.reader.getTransactionCount({ address: signer, blockTag: 'latest' }),
      getGasPrice(this.reader),
    ]);
    const gas = GAS_FLOOR + GAS_PER_EXTRA_OPERATION * BigInt(operations - 1) + extraGas;
    return { nonce, gas, gasPrice };
  }

  #serialized<T>(signer: Address, task: () => Promise<T>): Promise<T> {
    const key = signer.toLowerCase();
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const bounded = () => {
      let timer: NodeJS.Timeout;
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Arkiv transaction from ${signer} got no receipt within ${this.#txTimeoutMs} ms`),
            ),
          this.#txTimeoutMs,
        );
        timer.unref?.();
      });
      return Promise.race([task(), expiry]).finally(() => clearTimeout(timer));
    };
    const next = previous.then(bounded, bounded);
    this.#queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * A wallet client for a device the gateway has no key for. Its account signs transactions by
   * asking the device, and refuses everything else.
   */
  #deviceWallet(device: Address) {
    const key = device.toLowerCase();
    let wallet = this.#deviceWallets.get(key);
    if (!wallet) {
      const account = toAccount({
        address: device,
        signMessage: async () => {
          throw new Error('a device only signs Arkiv transactions');
        },
        signTypedData: async () => {
          throw new Error('a device only signs Arkiv transactions');
        },
        signTransaction: async (transaction, options) => {
          if (
            transaction.gasPrice === undefined ||
            transaction.nonce === undefined ||
            transaction.gas === undefined
          ) {
            throw new Error('device transactions must be legacy with explicit nonce, gas and gas price');
          }
          const unsigned: UnsignedTransaction = {
            chainId: transaction.chainId ?? this.chain.id,
            nonce: transaction.nonce,
            gas: transaction.gas.toString(),
            gasPrice: transaction.gasPrice.toString(),
            to: transaction.to as Address,
            value: (transaction.value ?? 0n).toString(),
            data: (transaction.data ?? '0x') as Hex,
          };
          const signature = await this.#signRequests.request(device, this.#purpose, unsigned);
          // Serialise exactly the fields the device reviewed, with its signature.
          const serialize = (options?.serializer ?? serializeTransaction) as typeof serializeTransaction;
          const fields = {
            type: 'legacy',
            chainId: unsigned.chainId,
            nonce: unsigned.nonce,
            gas: transaction.gas,
            gasPrice: transaction.gasPrice,
            to: unsigned.to,
            value: transaction.value ?? 0n,
            data: unsigned.data,
          } as const;
          // Anyone can post to the signatures endpoint; only the device's signature is used.
          const signed = concat(
            fromHex(signature.r, 32),
            fromHex(signature.s, 32),
            Uint8Array.of(27 + signature.yParity),
          );
          const signer = secpRecover(fromHex(keccak256(serializeTransaction(fields)), 32), signed).address;
          if (!sameAddress(signer, device))
            throw new Error("the signature returned for the device is not the device's");
          return serialize(fields, {
            r: signature.r,
            s: signature.s,
            v: 27n + BigInt(signature.yParity),
            yParity: signature.yParity,
          });
        },
      });
      wallet = createWalletClient({
        chain: this.chain,
        transport: this.#transport,
        account,
        pollingInterval: this.#pollingInterval,
      });
      this.#deviceWallets.set(key, wallet);
    }
    return wallet;
  }
}
