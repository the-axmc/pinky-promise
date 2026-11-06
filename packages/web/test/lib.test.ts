/**
 * The buyer page's logic, run in Node against the local stack: a device takes a lot through
 * its first handoff, and the page's own code then reads Arkiv and Hedera directly, checks every
 * record, verifies a geofence proof, decrypts the episode log and buys units on the market.
 */
import { Device, DeviceRunner, HttpGatewayLink, MemoryStorage, SimulatedAnchor, createSimulatedHardware, generateIdentity } from '@pinky/device';
import { type LocalStack, startLocalStack } from '@pinky/gateway';
import { CheckpointKind, type Hex } from '@pinky/protocol';
import { atsTokenAbi, receiptMarketAbi } from '@pinky/protocol/hedera';
import { GEOFENCE_VK_HASH, destroyBarretenberg } from '@pinky/zk/verify';
import { createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Context, connect } from '../src/lib/config';
import { fetchDemoViewKey, fetchEpisode } from '../src/lib/episode';
import { type LotView, listLots, loadLot, verifyProof } from '../src/lib/lot';
import { buy, demoWallet, explainRefusal, holdingOf, listingsFor, paymentValue, redeem } from '../src/lib/market';
import { allOk, checkCheckpoint, checkLot, checkReading } from '../src/lib/verify';

const ASSET = 'LOT-7';
const VENUE = { venueId: 'WH-MUM-01', name: 'Mumbai cold store', latDeg: 19.076, lonDeg: 72.8777 };

let stack: LocalStack;
let ctx: Context;
let view: LotView;
let stopSigning: () => Promise<void>;

beforeAll(async () => {
  stack = await startLocalStack({ gateway: { retryBaseMs: 300, retryMaxMs: 800 } });
  const anchor = new SimulatedAnchor(`0x${'31'.repeat(32)}`);
  anchor.setVenue(VENUE.venueId);
  const hardware = createSimulatedHardware(generateIdentity(), { anchor });
  hardware.position.set({ latDeg: 19.0761, lonDeg: 72.8778 });
  hardware.climate.set(450, 4500);
  const device = await Device.create(hardware, new MemoryStorage(), {
    registry: stack.registry,
    attestor: stack.publicConfig.attestor,
    arkivChainId: stack.arkiv.chainId,
  });
  const runner = new DeviceRunner(device, new HttpGatewayLink(stack.url));
  const admin = async (path: string, body: unknown) => {
    const response = await fetch(`${stack.url}/v1/admin${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stack.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`admin ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const { depositor, buyer } = stack.hedera.accounts;
  await admin('/venues', { ...VENUE, radiusM: 150, anchor: anchor.address });
  await admin('/devices', { certBundle: await device.certificate(), venueIds: [VENUE.venueId], label: 'Pocket sensor #1' });
  const lot = await admin('/lots', {
    assetId: ASSET,
    title: 'Specialty coffee lot #7',
    device: device.address,
    tempMinCenti: 200,
    tempMaxCenti: 800,
    rhMinCenti: 2000,
    rhMaxCenti: 7000,
    units: 100,
    unitValueCents: 1800,
    endsAt: Math.floor(Date.now() / 1000) + 3 * 86_400,
    disputeWindowS: 14 * 86_400,
    depositor: depositor.address,
  });
  await admin(`/lots/${ASSET}/investors`, { address: buyer.address });

  stopSigning = runner.startSigning(100);
  await runner.reading();
  await runner.reading();
  const sent = await runner.checkpoint(CheckpointKind.WAREHOUSE_IN);
  const decided = await runner.awaitDecision(sent.checkpointId, { timeoutMs: 60_000 });
  if (decided.status !== 'ACCEPTED') throw new Error(`setup: custody was ${decided.status}`);
  await stack.gateway.idle();

  // The depositor offers 40 units on the market.
  ctx = await connect(stack.url);
  const wallet = createWalletClient({ chain: ctx.hederaChain, transport: http(), account: privateKeyToAccount(depositor.privateKey) });
  const reader = ctx.hedera;
  await stack.gateway.hedera.allowlistSpender(lot.token, stack.hedera.market);
  for (const hash of [
    await wallet.writeContract({ address: lot.token, abi: atsTokenAbi, functionName: 'approve', args: [stack.hedera.market, 40n], chain: ctx.hederaChain }),
    await wallet.writeContract({ address: stack.hedera.market, abi: receiptMarketAbi, functionName: 'list', args: [lot.token, 40n, parseEther('0.02')], chain: ctx.hederaChain }),
  ]) {
    await reader.waitForTransactionReceipt({ hash });
  }

  view = (await loadLot(ctx, ASSET, GEOFENCE_VK_HASH))!;
}, 240_000);

afterAll(async () => {
  await stopSigning?.();
  await destroyBarretenberg();
  await stack?.stop();
});

describe('what the buyer page reads and checks', () => {
  it('finds the lot on Arkiv and trusts it for the right reasons', async () => {
    expect((await listLots(ctx)).map((lot) => lot.assetId)).toEqual([ASSET]);
    expect(view.lot.title).toBe('Specialty coffee lot #7');
    expect(view.lotChecks.map((check) => check.ok)).toEqual([true, true, true]);
    expect(view.deviceChecks.map((check) => check.ok)).toEqual([true, true]);
    // The same record under a registry the buyer does not trust is rejected.
    expect(checkLot(view.lot, `0x${'99'.repeat(20)}`).map((check) => check.ok)).toEqual([false, false, true]);
  });

  it('reads the custody state and supply from Hedera', () => {
    expect(view.onChain).toMatchObject({ state: 'IN_CUSTODY', breachOpen: false, totalSupply: 100n, agreesWithArkiv: true });
  });

  it('accepts readings only from the device, and notices a forged one', () => {
    expect(view.readings.map((reading) => [reading.seq, reading.inRange])).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(view.readings.every((reading) => allOk(reading.checks))).toBe(true);
    expect(view.readings.every((reading) => reading.venue?.venueId === VENUE.venueId && reading.proof)).toBe(true);
    const forged = { ...view.readings[0]!, digest: view.readings[1]!.digest };
    expect(checkReading(forged, view.lot).map((check) => check.ok)).toEqual([true, false]);
    const impostor = { ...view.readings[0]!, creator: `0x${'12'.repeat(20)}` as Hex };
    expect(checkReading(impostor, view.lot)[0]).toMatchObject({ ok: false });
  });

  it('checks the handoff: device signature, attested decision, venue anchor', () => {
    expect(view.checkpoints).toHaveLength(1);
    const record = view.checkpoints[0]!;
    expect(record).toMatchObject({ kind: 'WAREHOUSE_IN', decision: 'ACCEPT_CUSTODY', outcome: 'ACCEPTED', zgSource: 'dev-mock' });
    expect(record.zgRequestId).toMatch(/^mock-/);
    expect(record.checks.map((check) => [check.label, check.ok])).toEqual([
      ['Written by the device wallet', true],
      ['Checkpoint signed by the device', true],
      ["Decision attested by the lot's attestor", true],
      ['Every reading it was judged on is published', true],
      ["Venue anchor co-signed (the device was in the venue's radio range)", true],
    ]);
    // A reading that was signed but never published shows as a gap.
    const withheld = checkCheckpoint(record, view.lot, view.venues, view.readings.slice(1));
    expect(withheld[3]).toEqual({ ok: false, label: 'Every reading it was judged on is published', detail: '1 of 2 readings are on Arkiv' });
    // And one swapped for another does not hash to what the device committed to.
    const swapped = checkCheckpoint(record, view.lot, view.venues, [view.readings[0]!, { ...view.readings[1]!, digest: view.readings[0]!.digest }]);
    expect(swapped[3]).toMatchObject({ ok: false });
    // A decision attested by anyone but the lot's attestor does not count.
    const otherAttestor = { ...view.lot, attestor: `0x${'77'.repeat(20)}` as Hex };
    expect(checkCheckpoint(record, otherAttestor, view.venues)[2]).toMatchObject({ ok: false });
    // Nor does a request id that is not the one that was attested.
    expect(checkCheckpoint({ ...record, zgRequestId: 'mock-something-else' }, view.lot, view.venues)[2]).toMatchObject({ ok: false });
  });

  it('verifies a geofence proof from public data, and not for another venue', async () => {
    expect(view.proofs).toHaveLength(2);
    expect(view.proofs.every((proof) => allOk(proof.checks))).toBe(true);
    expect(await verifyProof(view, view.proofs[0]!)).toBe(true);
    const elsewhere = { ...view, venues: view.venues.map((venue) => ({ ...venue, box: { ...venue.box, latMin: venue.box.latMin + 5_000, latMax: venue.box.latMax + 5_000 } })) };
    expect(await verifyProof(elsewhere, view.proofs[0]!)).toBe(false);
  }, 120_000);

  it('decrypts the episode log with the view key and re-verifies its readings', async () => {
    const root = view.checkpoints[0]!.episodeRoot!;
    const episode = await fetchEpisode(ctx, root, await fetchDemoViewKey(ctx, ASSET));
    expect(episode.readings.map((reading) => [reading.seq, reading.tempCenti])).toEqual([
      [1, 450],
      [2, 450],
    ]);
    expect(episode.photo?.mime).toBe('image/png');
    expect(episode.log.decision).toMatchObject({ decision: 'ACCEPT_CUSTODY' });
    await expect(fetchEpisode(ctx, root, `0x${'00'.repeat(32)}`)).rejects.toThrow(/wrong key/);
  });

  it('buys units through the market with the demo wallet', async () => {
    const [listing] = await listingsFor(ctx, view.onChain!.token);
    expect(listing).toMatchObject({ unitsLeft: 40n, pricePerUnit: parseEther('0.02') });
    const buyer = demoWallet(ctx)!;
    expect(buyer.address).toBe(stack.hedera.accounts.buyer.address.toLowerCase());
    expect(await holdingOf(ctx, view.onChain!.token, buyer.address)).toEqual({ free: 0n, frozen: 0n, allowlisted: true, kyc: true });

    await buy(ctx, buyer, listing!, 5n);
    expect(await holdingOf(ctx, view.onChain!.token, buyer.address)).toMatchObject({ free: 5n });
    expect((await listingsFor(ctx, view.onChain!.token))[0]!.unitsLeft).toBe(35n);
  });

  it('is refused by the token itself when the buyer is not allow-listed', async () => {
    const [listing] = await listingsFor(ctx, view.onChain!.token);
    const outsider = stack.hedera.accounts.outsider;
    const wallet = createWalletClient({ chain: ctx.hederaChain, transport: http(), account: privateKeyToAccount(outsider.privateKey) });
    await expect(buy(ctx, { address: outsider.address.toLowerCase() as Hex, wallet, kind: 'browser' }, listing!, 1n)).rejects.toThrow();
    expect((await listingsFor(ctx, view.onChain!.token))[0]!.unitsLeft).toBe(35n);
  });

  it('redeems units: they are burned and the supply shrinks', async () => {
    const buyer = demoWallet(ctx)!;
    const token = view.onChain!.token;
    await redeem(ctx, buyer, token, 2n);
    expect(await holdingOf(ctx, token, buyer.address)).toMatchObject({ free: 3n });
    expect((await loadLot(ctx, ASSET, GEOFENCE_VK_HASH))!.onChain!.totalSupply).toBe(98n);
  });

  it('explains a refusal by the token in words', () => {
    expect(explainRefusal(new Error('The contract function "buy" reverted with the following signature: 0x66eb1b54'))).toMatch(/compliance rules do not allow trading/);
    expect(explainRefusal(new Error('insufficient funds\nfor gas'))).toBe('insufficient funds for gas');
  });

  it('scales the payment for Hedera, where contracts count in tinybar', () => {
    expect(paymentValue(31337, 5n)).toBe(5n);
    expect(paymentValue(296, 5n)).toBe(50_000_000_000n);
  });
});
