/**
 * Deploys the two contracts this project adds to Hedera — the custody oracle and the receipt
 * market — with the issuer key: `pnpm deploy:hedera`.
 *
 * The receipt tokens themselves are not deployed here: each lot's token is created through the
 * Asset Tokenization Studio factory when the lot is created.
 */
import { custodyOracleAbi, custodyOracleBytecode, receiptMarketAbi, receiptMarketBytecode } from '@pinky/protocol/hedera';
import { type Abi, type Hex, createPublicClient, createWalletClient, defineChain, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ConfigError, loadEnvFile, readConfig } from './config';

async function main(): Promise<void> {
  loadEnvFile();
  // Placeholders satisfy the parts of the configuration a deployment does not need.
  const config = readConfig(process.env, ['HEDERA_ISSUER_KEY']);
  const { rpcUrl, chainId, explorerUrl } = config.hedera;
  const chain = defineChain({
    id: chainId,
    name: `hedera-${chainId}`,
    nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(config.hedera.issuerKey);
  const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 2_000 });
  const wallet = createWalletClient({ chain, transport: http(), account });

  const actual = await publicClient.getChainId();
  if (actual !== chainId) throw new Error(`${rpcUrl} is chain ${actual}, but HEDERA_CHAIN_ID is ${chainId}`);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer ${account.address} on chain ${chainId}: ${formatEther(balance)} HBAR`);
  if (balance === 0n) throw new Error('the deployer has no HBAR: fund it at https://portal.hedera.com/faucet');

  const deploy = async (name: string, abi: Abi, bytecode: Hex) => {
    // Hedera bills at least 80 % of the gas limit, so stay close to the estimate.
    const estimate = await publicClient.estimateGas({ account: account.address, data: bytecode });
    const hash = await wallet.deployContract({ abi, bytecode, gas: (estimate * 125n) / 100n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed (${hash})`);
    console.log(`${name}  ${receipt.contractAddress}   ${explorerUrl}/contract/${receipt.contractAddress}`);
    return receipt.contractAddress;
  };

  const oracle = await deploy('CustodyOracle', custodyOracleAbi as Abi, custodyOracleBytecode);
  const market = await deploy('ReceiptMarket', receiptMarketAbi as Abi, receiptMarketBytecode);

  console.log(`
Add to .env:

HEDERA_ORACLE=${oracle}
HEDERA_MARKET=${market}

Verify the sources on HashScan (Sourcify), from the contracts/ folder:

  forge verify-contract --chain-id ${chainId} --verifier sourcify --verifier-url https://server-verify.hashscan.io \\
    ${oracle} src/CustodyOracle.sol:CustodyOracle
  forge verify-contract --chain-id ${chainId} --verifier sourcify --verifier-url https://server-verify.hashscan.io \\
    ${market} src/ReceiptMarket.sol:ReceiptMarket
`);
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `\n${error.message}\n\nSee .env.example.` : `\n${(error as Error).message}`);
  process.exit(1);
});
