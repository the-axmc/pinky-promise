/**
 * Opening a device the way the command line and the demo do, and the bring-up probe — against
 * in-memory boards.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CheckpointKind,
  type Hex,
  addressFromPublicKey,
  fromHex,
  secpAddress,
  signLotProfile,
  verifyDeviceCert,
  verifyReading,
} from '@pinky/protocol';
import {
  BoardClient,
  type DeviceSession,
  MockBoard,
  loadProvisioning,
  openDeviceSession,
  probeBoard,
} from '../src';

const registrySecret = fromHex(`0x${'66'.repeat(32)}`);
const provisioning = {
  registry: secpAddress(registrySecret),
  attestor: secpAddress(fromHex(`0x${'55'.repeat(32)}`)),
  arkivChainId: 1337,
};
const anchorBlock = { blockNumber: 7, blockHash: `0x${'ab'.repeat(32)}` as Hex };
const sessions: DeviceSession[] = [];
const open = async (options: Parameters<typeof openDeviceSession>[0]) => {
  const session = await openDeviceSession(options);
  sessions.push(session);
  return session;
};
const assign = (session: DeviceSession, assetId = 'LOT-42') =>
  session.device.setProfile(
    signLotProfile(
      {
        assetId,
        device: session.device.address,
        tempMinCenti: 200,
        tempMaxCenti: 800,
        rhMinCenti: 2000,
        rhMaxCenti: 7000,
        validUntil: Math.floor(Date.now() / 1000) + 86_400,
      },
      registrySecret,
    ),
  );

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

describe('opening a device', () => {
  it('is fully simulated without a board, and keeps its identity between runs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pinky-device-'));
    const first = await open({ provisioning, dataDir });
    expect(first.plan).toMatchObject({ wallet: 'sim', climate: 'sim', photo: 'sim' });
    assign(first);
    expect(first.steer.climate(430, 4400)).toBe(true);
    expect(verifyReading(await first.device.takeReading(anchorBlock)).reading).toMatchObject({
      tempCenti: 430,
      seq: 1,
    });
    const certificate = await first.device.certificate();
    await first.close();

    expect(readdirSync(dataDir).sort()).toEqual(['identity.json', `state-${first.device.address}.json`]);
    const again = await open({ provisioning, dataDir });
    expect(again.device.address).toBe(first.device.address);
    expect(await again.device.certificate()).toBe(certificate);
    // The counter carries on where it stopped.
    again.steer.climate(430, 4400);
    expect(verifyReading(await again.device.takeReading(anchorBlock)).reading.seq).toBe(2);
  });

  it('uses the parts a board reports and can still be steered through an in-memory board', async () => {
    const mockBoard = new MockBoard();
    const logs: string[] = [];
    const session = await open({ provisioning, port: 'mock', mockBoard, log: (line) => logs.push(line) });
    expect(session.boardInfo?.board).toBe('mock');
    expect(session.plan).toMatchObject({
      wallet: 'board',
      secureElement: 'board',
      climate: 'board',
      position: 'board',
      photo: 'board',
      nfc: 'board',
    });
    expect(session.device.address).toBe(addressFromPublicKey(mockBoard.publicKey));
    assign(session);
    expect(session.steer.climate(1260, 4500)).toBe(true);
    expect(session.steer.position({ latDeg: 19.0761, lonDeg: 72.8778 })).toBe(true);
    expect(session.steer.seal('broken')).toBe(true);
    const reading = await session.device.takeReading(anchorBlock);
    expect(verifyReading(reading).reading.tempCenti).toBe(1260);
    expect(reading.opening).toBeDefined();
    expect(logs.some((line) => line.includes('pinky-bridge mock device ready'))).toBe(true);
  });

  it('falls back to a simulated secure element while the ATECC608B is still blank', async () => {
    const mockBoard = new MockBoard();
    mockBoard.seProvisioned = false;
    const logs: string[] = [];
    const session = await open({ provisioning, port: 'mock', mockBoard, log: (line) => logs.push(line) });
    expect(session.plan.secureElement).toBe('sim');
    expect(session.plan.wallet).toBe('board');
    expect(logs.join('\n')).toMatch(/ATECC608B is not usable yet/);
    expect(verifyDeviceCert(await session.device.certificate()).cert.device).toBe(session.device.address);
  });

  it('refuses to carry an enrolment over to a different secure element', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pinky-device-'));
    const walletSecret: Hex = `0x${'29'.repeat(32)}`;
    const blank = new MockBoard({ walletSecret });
    blank.seProvisioned = false;
    const before = await open({ provisioning, dataDir, port: 'mock', mockBoard: blank });
    await before.device.certificate();
    await before.close();
    // Same wallet, but now the real chip is there: the stored certificate names another key.
    await expect(
      open({ provisioning, dataDir, port: 'mock', mockBoard: new MockBoard({ walletSecret }) }),
    ).rejects.toThrow(/enrolled with a different secure element/);
  });

  it('takes the anchor from its own board, and checks each board plays its role', async () => {
    const mockAnchorBoard = new MockBoard({ role: 'anchor', venueId: 'WH-MUM-01' });
    const session = await open({ provisioning, port: 'mock', anchorPort: 'mock', mockAnchorBoard });
    expect(session.plan.anchor).toBe('board');
    assign(session);
    await session.device.takeReading(anchorBlock);
    const checkpoint = await session.device.takeCheckpoint(CheckpointKind.WAREHOUSE_IN, anchorBlock);
    expect(checkpoint.anchor).toBeDefined();
    await expect(open({ provisioning, port: 'mock', mockBoard: mockAnchorBoard })).rejects.toThrow(
      /is a venue anchor, not a device/,
    );
    await expect(
      open({ provisioning, anchorPort: 'mock', mockAnchorBoard: new MockBoard() }),
    ).rejects.toThrow(/is not a venue anchor/);
  });

  it('says honestly when a real part cannot be steered', async () => {
    const session = await open({
      provisioning,
      port: 'mock',
      photos: '/somewhere/photos',
      simulate: ['sht31'],
    });
    expect(session.steer.climate(500, 4500)).toBe(true); // simulated on request
    expect(session.steer.seal('broken')).toBe(false); // photos come from a folder
    expect(session.plan.photo).toEqual({ file: '/somewhere/photos' });
  });

  it('stores what the device trusts once, at provisioning', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pinky-device-'));
    let asked = 0;
    const fresh = async () => (asked++, provisioning);
    expect(await loadProvisioning(dataDir, fresh)).toEqual(provisioning);
    expect(await loadProvisioning(dataDir, fresh)).toEqual(provisioning);
    expect(asked).toBe(1);
    expect(JSON.parse(readFileSync(join(dataDir, 'provisioning.json'), 'utf8'))).toEqual(provisioning);
    expect(existsSync(join(dataDir, 'identity.json'))).toBe(false);
  });
});

describe('bring-up probe', () => {
  const probe = async (board: MockBoard) => {
    const client = new BoardClient(board.transport);
    try {
      return await probeBoard(client, { nfcTimeoutMs: 50 });
    } finally {
      await client.close();
    }
  };
  const row = (rows: Array<{ part: string; ok: boolean | null; detail: string }>, part: string) =>
    rows.find((r) => r.part.startsWith(part))!;

  it('reports every working part of a fully wired device', async () => {
    const board = new MockBoard();
    board.gps = { latDeg: 19.0761, lonDeg: 72.8778 };
    const { rows } = await probe(board);
    expect(rows.filter((r) => r.ok !== true).map((r) => r.part)).toEqual(['venue anchor (over BLE)']);
    expect(row(rows, 'SHT31').detail).toBe('4.80 °C, 45.00 %RH');
    expect(row(rows, 'GPS').detail).toMatch(/^fix 19\.0761000, 72\.8778000 \(9 satellites/);
    expect(row(rows, 'ATECC608B').detail).toMatch(/signs and verifies/);
    expect(row(rows, 'device wallet').detail).toContain(addressFromPublicKey(board.publicKey));
    expect(row(rows, 'PN532').detail).toMatch(/tag 04a1b2c3d4e5f6/);
    expect(row(rows, 'venue anchor').ok).toBeNull();
  });

  it('tells a missing part from a failing one, and says what to do', async () => {
    const board = new MockBoard({ parts: { camera: false, enclosure: false } });
    board.seProvisioned = false;
    board.nfc = null;
    board.breakPart('climate.read', 'sht31 crc');
    const { rows } = await probe(board);
    expect(row(rows, 'SHT31')).toMatchObject({ ok: false, detail: 'sht31 crc' });
    expect(row(rows, 'ATECC608B')).toMatchObject({ ok: false });
    expect(row(rows, 'ATECC608B').detail).toMatch(/provision-se/);
    expect(row(rows, 'camera')).toMatchObject({ ok: null, detail: 'not detected' });
    expect(row(rows, 'GPS').detail).toMatch(/no fix yet/);
    expect(row(rows, 'PN532')).toMatchObject({
      ok: true,
      detail: 'reader answers; no tag in the field right now',
    });
  });

  it('checks an anchor board, and a device that reaches one over BLE', async () => {
    const unset = await probe(new MockBoard({ role: 'anchor' }));
    expect(unset.rows).toHaveLength(1);
    expect(unset.rows[0]).toMatchObject({ ok: false });
    expect(unset.rows[0]!.detail).toMatch(/anchor-setup/);

    const anchor = new MockBoard({ role: 'anchor', venueId: 'DOCK-7' });
    const configured = await probe(anchor);
    expect(configured.rows[0]).toMatchObject({ ok: true });
    expect(configured.rows[0]!.detail).toMatch(/venue DOCK-7, address 0x[0-9a-f]{40}, co-signs/);

    const inRange = await probe(new MockBoard({ bleAnchor: anchor }));
    expect(row(inRange.rows, 'venue anchor')).toMatchObject({ ok: true });
    expect(row(inRange.rows, 'venue anchor').detail).toMatch(/venue DOCK-7, signer 0x/);
    anchor.unplug();
    const outOfRange = await probe(new MockBoard({ bleAnchor: anchor }));
    expect(row(outOfRange.rows, 'venue anchor')).toMatchObject({
      ok: true,
      detail: 'radio works; no anchor in range right now',
    });
  });
});
