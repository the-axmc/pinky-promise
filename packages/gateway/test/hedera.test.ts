import { type HederaDevnet, hederaDevChain, startHederaDevnet } from '@pinky/devnet';
import {
  CheckpointKind,
  type CheckpointKindValue,
  Decision,
  type DecisionValue,
  type Hex,
  LotState,
  Outcome,
  ZERO_32,
  checkpointDigest,
  fromHex,
  requestIdHash,
  secpAddress,
  signCheckpoint,
  signDecisionAttestation,
  signReading,
  toHex,
} from '@pinky/protocol';
import { atsTokenAbi, receiptMarketAbi } from '@pinky/protocol/hedera';
import { createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HederaAdapter } from '../src/hedera/adapter';

const deviceSecret = fromHex(`0x${'11'.repeat(32)}`);
const attestorSecret = fromHex(`0x${'55'.repeat(32)}`);
const device = secpAddress(deviceSecret);
const attestor = secpAddress(attestorSecret);
const ASSET = 'LOT-42';
const thresholds = { tempMinCenti: 200, tempMaxCenti: 800, rhMinCenti: 2000, rhMaxCenti: 7000 };
const blockhash = `0x${'cd'.repeat(32)}` as Hex;

let devnet: HederaDevnet;
let hedera: HederaAdapter;
let token: `0x${string}`;
let seq = 10;

/** A decided checkpoint as the device and the gateway would sign it. */
function decided(kind: CheckpointKindValue, decision: DecisionValue, breach = false) {
  seq += 10;
  const checkpoint = signCheckpoint(
    {
      device,
      assetId: ASSET,
      kind,
      ts: 1_793_966_400 + seq,
      seq,
      firstSeq: seq - 2,
      lastSeq: seq - 1,
      readingCount: 2,
      readingsRoot: `0x${'aa'.repeat(32)}`,
      sealHash: `0x${'bb'.repeat(32)}`,
      anchorDigest: ZERO_32,
      blockhash,
    },
    deviceSecret,
  );
  const attestation = signDecisionAttestation(
    {
      checkpointDigest: toHex(checkpointDigest(fromHex(checkpoint.payload))),
      decision,
      breach,
      requestIdHash: requestIdHash(`req-${seq}`),
      episodeRoot: `0x${'0f'.repeat(32)}`,
      decidedAt: 1_793_966_500 + seq,
    },
    attestorSecret,
  );
  const breachReading = breach
    ? signReading(
        {
          device,
          assetId: ASSET,
          tempCenti: 1260,
          rhCenti: 4550,
          gpsCommitment: ZERO_32,
          ts: 1_793_966_400 + seq - 1,
          seq: seq - 1,
          blockhash,
        },
        deviceSecret,
      )
    : undefined;
  return {
    checkpoint: checkpoint.payload,
    deviceSig: checkpoint.sig,
    attestation: attestation.payload,
    attestorSig: attestation.sig,
    ...(breachReading ? { breachReading: { payload: breachReading.payload, sig: breachReading.sig } } : {}),
  };
}

beforeAll(async () => {
  devnet = await startHederaDevnet();
  hedera = new HederaAdapter({
    rpcUrl: devnet.rpcUrl,
    chainId: devnet.chainId,
    factory: devnet.factory,
    resolver: devnet.resolver,
    oracle: devnet.oracle,
    market: devnet.market,
    issuerKey: devnet.accounts.issuer.privateKey,
    relayerKey: devnet.accounts.relayer.privateKey,
    inspectorKey: devnet.accounts.inspector.privateKey,
    pollingIntervalMs: 50,
  });
}, 120_000);

afterAll(async () => {
  await devnet?.stop();
});

describe('Hedera adapter on the real ATS contracts', () => {
  it('deploys the receipt token through the ATS Factory', async () => {
    const deployed = await hedera.deployReceiptToken({ assetId: ASSET, units: 100, unitValueCents: 1800 });
    token = deployed.token;
    const read = { address: token, abi: atsTokenAbi } as const;
    expect(await hedera.publicClient.readContract({ ...read, functionName: 'name' })).toBe('Warehouse Receipt LOT-42');
    expect(await hedera.publicClient.readContract({ ...read, functionName: 'symbol' })).toBe('WRLOT42');
    expect(await hedera.publicClient.readContract({ ...read, functionName: 'decimals' })).toBe(0);
    expect((await hedera.publicClient.readContract({ ...read, functionName: 'compliance' })).toLowerCase()).toBe(
      devnet.oracle.toLowerCase(),
    );
    expect(await hedera.isTokenAdmin(token, hedera.issuer)).toBe(true);
    expect(await hedera.lot(ASSET)).toBeUndefined();
  }, 60_000);

  it('registers the lot in the custody oracle', async () => {
    await hedera.registerLot({ assetId: ASSET, token, device, attestor, thresholds });
    expect(await hedera.lot(ASSET)).toMatchObject({
      token,
      device,
      attestor,
      inspector: hedera.inspector,
      state: LotState.REGISTERED,
      breachOpen: false,
    });
  });

  it('cannot issue before custody is accepted, and can after', async () => {
    const depositor = devnet.accounts.depositor.address;
    await hedera.onboardInvestor(token, depositor);
    await hedera.onboardInvestor(token, depositor); // idempotent
    await expect(hedera.issue(token, depositor, 100)).rejects.toThrow();

    const applied = await hedera.submitCheckpoint(decided(CheckpointKind.WAREHOUSE_IN, Decision.ACCEPT_CUSTODY));
    expect(applied).toMatchObject({ outcome: Outcome.ACCEPTED, stateAfter: LotState.IN_CUSTODY });

    await hedera.issue(token, depositor, 100);
    expect(await hedera.holding(token, depositor)).toEqual({ free: 100n, frozen: 0n, total: 100n });
    expect(await hedera.totalSupply(token)).toBe(100n);
  }, 60_000);

  it('lets an onboarded buyer purchase through the market', async () => {
    const chain = { ...hederaDevChain(devnet.rpcUrl, devnet.chainId) };
    const depositor = createWalletClient({
      chain,
      transport: http(),
      account: privateKeyToAccount(devnet.accounts.depositor.privateKey),
    });
    const buyer = createWalletClient({
      chain,
      transport: http(),
      account: privateKeyToAccount(devnet.accounts.buyer.privateKey),
    });
    const wait = (hash: Hex) => hedera.publicClient.waitForTransactionReceipt({ hash });

    await hedera.allowlistSpender(token, devnet.market);
    await hedera.onboardInvestor(token, devnet.accounts.buyer.address);
    await wait(await depositor.writeContract({ address: token, abi: atsTokenAbi, functionName: 'approve', args: [devnet.market, 40n] }));
    await wait(
      await depositor.writeContract({
        address: devnet.market,
        abi: receiptMarketAbi,
        functionName: 'list',
        args: [token, 40n, parseEther('2')],
      }),
    );
    await wait(
      await buyer.writeContract({
        address: devnet.market,
        abi: receiptMarketAbi,
        functionName: 'buy',
        args: [0n, 10n],
        value: parseEther('20'),
      }),
    );
    expect((await hedera.holding(token, devnet.accounts.buyer.address)).free).toBe(10n);
    expect((await hedera.holding(token, devnet.accounts.depositor.address)).free).toBe(90n);
  }, 60_000);

  it('freezes every holder on a REJECT with a device-signed breach, and releases', async () => {
    await hedera.submitCheckpoint(decided(CheckpointKind.WAREHOUSE_OUT, Decision.ACCEPT_CUSTODY));
    expect((await hedera.lot(ASSET))?.state).toBe(LotState.IN_TRANSIT);

    const applied = await hedera.submitCheckpoint(decided(CheckpointKind.DOCK_HANDOFF, Decision.REJECT, true));
    expect(applied).toMatchObject({ outcome: Outcome.FROZEN, stateAfter: LotState.FROZEN });
    expect(await hedera.holding(token, devnet.accounts.depositor.address)).toEqual({ free: 0n, frozen: 90n, total: 90n });
    expect(await hedera.holding(token, devnet.accounts.buyer.address)).toEqual({ free: 0n, frozen: 10n, total: 10n });
    expect(await hedera.lot(ASSET)).toMatchObject({ state: LotState.FROZEN, breachOpen: true, lastSeq: seq });

    await hedera.release(ASSET, `0x${'ee'.repeat(32)}`, seq);
    expect(await hedera.lot(ASSET)).toMatchObject({ state: LotState.IN_CUSTODY, breachOpen: false, clearedSeq: seq });
    expect((await hedera.holding(token, devnet.accounts.buyer.address)).free).toBe(10n);
  }, 60_000);

  it('surfaces an oracle refusal instead of sending a doomed transaction', async () => {
    // A stale checkpoint (seq not above the last applied one) reverts in simulation.
    seq -= 20;
    await expect(
      hedera.submitCheckpoint(decided(CheckpointKind.FINAL_DELIVERY, Decision.ACCEPT_CUSTODY)),
    ).rejects.toThrow();
    seq += 20;
  });
});
