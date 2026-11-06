/**
 * The hardware bridge, exercised against the in-memory board: the same JSON-lines protocol the
 * firmware speaks, the same seam classes a real board is driven through, no hardware attached.
 */
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CheckpointKind,
  type Hex,
  ZERO_32,
  addressFromPublicKey,
  decodeSealEvidence,
  fromHex,
  gpsCommitment,
  p256Verify,
  sealReportsTamper,
  secpAddress,
  secpRecover,
  secpSign,
  sha256,
  signLotProfile,
  toHex,
  verifyAnchorAttestation,
  verifyCheckpoint,
  verifyDeviceCert,
  verifyReading,
} from '@pinky/protocol';
import {
  BoardAnchor,
  BoardClient,
  BoardClimate,
  BoardError,
  BoardPosition,
  BoardSecureElement,
  BoardWallet,
  CompositeSeal,
  Device,
  MemoryStorage,
  MockBoard,
  SIMULATED_PLAN,
  SimulatedAnchor,
  assembleHardware,
  boardCamera,
  describePlan,
  filePhoto,
  generateIdentity,
  planFor,
  toRecoverable,
} from '../src';

const registrySecret = fromHex(`0x${'66'.repeat(32)}`);
const registry = secpAddress(registrySecret);
const attestor = secpAddress(fromHex(`0x${'55'.repeat(32)}`));
const anchorBlock = { blockNumber: 1200, blockHash: `0x${'cd'.repeat(32)}` as Hex };
const NOW = 1_793_966_400;
const digest = sha256(new TextEncoder().encode('a digest to sign'));

const clients: BoardClient[] = [];
function connect(board: MockBoard, onLog?: (line: string) => void): BoardClient {
  const client = new BoardClient(board.transport, onLog ? { onLog } : {});
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('bridge client', () => {
  it('matches answers to requests and keeps log lines out of the way', async () => {
    const board = new MockBoard();
    const logs: string[] = [];
    const client = connect(board, (line) => logs.push(line));
    const [info, climate] = await Promise.all([client.info(), client.request('climate.read')]);
    expect(info).toMatchObject({ role: 'device', has: { sht31: true, camera: true, gps: true } });
    expect(climate).toEqual({ temp_centi: 480, rh_centi: 4500 });
    expect(logs).toContain('pinky-bridge mock device ready');
  });

  it('reports what the board said when a part fails', async () => {
    const board = new MockBoard({ parts: { sht31: false } });
    const client = connect(board);
    await expect(client.request('climate.read')).rejects.toMatchObject({ name: 'BoardError', reason: 'unsupported' });
    board.breakPart('gps.read', 'uart framing');
    const failure = await client.request('gps.read').catch((error) => error);
    expect(failure).toBeInstanceOf(BoardError);
    expect(failure.message).toBe('board: gps.read: uart framing');
  });

  it('gives up on a board that stopped answering', async () => {
    const board = new MockBoard();
    const client = connect(board);
    board.unplug();
    await expect(client.request('climate.read', {}, 60)).rejects.toThrow(/no answer within 60 ms/);
  });

  it('waits out the boot of a board that resets when its port is opened', async () => {
    const board = new MockBoard();
    const client = connect(board);
    board.unplug();
    setTimeout(() => board.replug(), 250);
    const info = await client.waitReady(3_000);
    expect(info.fw).toBe('mock-0.1.0');
    board.unplug();
    await expect(connect(board).waitReady(250)).rejects.toThrow(/did not answer within 250 ms/);
  });

  it('fails pending and later requests once closed', async () => {
    const board = new MockBoard();
    const client = connect(board);
    board.unplug();
    const pending = client.request('climate.read');
    await client.close();
    await expect(pending).rejects.toThrow(/connection closed/);
    await expect(client.request('climate.read')).rejects.toThrow(/connection closed/);
    expect(board.closed).toBe(true);
  });
});

describe('signatures from a microcontroller', () => {
  const secret = fromHex(`0x${'42'.repeat(32)}`);
  const signer = secpAddress(secret);
  const reference = secpSign(digest, secret);

  it('adds the recovery byte the board does not send', () => {
    expect(toHex(toRecoverable(digest, reference.slice(0, 64), signer))).toBe(toHex(reference));
  });

  it('normalises a high s, which ecrecover-style verifiers refuse', () => {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = reference.slice(0, 64);
    high.set(fromHex(`0x${(n - BigInt(toHex(reference.subarray(32, 64)))).toString(16).padStart(64, '0')}`, 32), 32);
    expect(toHex(high)).not.toBe(toHex(reference.slice(0, 64)));
    expect(toHex(toRecoverable(digest, high, signer))).toBe(toHex(reference));
  });

  it('refuses a signature made by a different key', () => {
    expect(() => toRecoverable(digest, reference.slice(0, 64), `0x${'12'.repeat(20)}`)).toThrow(/expected key/);
    expect(() => toRecoverable(digest, reference.slice(0, 63), signer)).toThrow(/64 bytes/);
  });
});

describe('parts on a board', () => {
  it('reads the SHT31 in hundredths', async () => {
    const board = new MockBoard();
    board.climate = { tempCenti: -1250, rhCenti: 9990 };
    expect(await new BoardClimate(connect(board)).read()).toEqual({ tempCenti: -1250, rhCenti: 9990 });
  });

  it('reports a GPS fix, and no position without one or with a stale one', async () => {
    const board = new MockBoard();
    const gps = new BoardPosition(connect(board), { maxAgeMs: 5_000 });
    expect(await gps.read()).toBeNull();
    board.gps = { latDeg: 19.0761234, lonDeg: -72.8778001 };
    expect(await gps.read()).toEqual({ latDeg: 19.0761234, lonDeg: -72.8778001 });
    board.gps = { latDeg: 19.0761234, lonDeg: -72.8778001, ageMs: 60_000 };
    expect(await gps.read()).toBeNull();
  });

  it('signs with the ATECC608B key, which verifies as P-256', async () => {
    const board = new MockBoard({ seSerial: '0x0123aabbccddeeffee' });
    const element = new BoardSecureElement(connect(board));
    expect(await element.serial()).toBe('0x0123aabbccddeeffee');
    const signature = await element.sign(digest);
    expect(p256Verify(digest, signature, await element.publicKey())).toBe(true);
  });

  it('says so when the ATECC608B has not been provisioned yet', async () => {
    const board = new MockBoard();
    board.seProvisioned = false;
    const client = connect(board);
    await expect(new BoardSecureElement(client).publicKey()).rejects.toThrow(/not provisioned/);
    await expect(client.request('se.provision', { confirm: 'yes' })).rejects.toThrow(/LOCK-FOREVER/);
    const provisioned = await client.request('se.provision', { confirm: 'LOCK-FOREVER' });
    expect(provisioned.locked).toBe(true);
    await expect(client.request('se.provision', { confirm: 'LOCK-FOREVER' })).rejects.toThrow(/already locked/);
  });

  it.each([false, true])('signs with the wallet in flash (high s: %s)', async (highS) => {
    const walletSecret: Hex = `0x${'29'.repeat(32)}`;
    const board = new MockBoard({ walletSecret, highS });
    const wallet = new BoardWallet(connect(board));
    expect(await wallet.address()).toBe(secpAddress(fromHex(walletSecret)));
    const signature = await wallet.signDigest(digest);
    expect(signature).toHaveLength(65);
    expect(secpRecover(digest, signature).address).toBe(await wallet.address());
  });
});

describe('seal evidence from a board', () => {
  it('combines the camera, the NFC seal tag and the enclosure switch', async () => {
    const board = new MockBoard();
    const client = connect(board);
    const seal = new CompositeSeal({ photo: boardCamera(client), nfc: client, enclosure: client });
    const { evidence, photo } = await seal.capture();
    expect(photo?.mime).toBe('image/png');
    expect(evidence).toEqual({
      v: 1,
      photo: { sha256: toHex(sha256(photo!.bytes)), mime: 'image/png', source: 'device-camera' },
      nfc: { uid: '0x04a1b2c3d4e5f6', tagType: 'ntag21x', tamper: 'unknown' },
      enclosure: { closed: true, openCount: 0 },
    });
    expect(sealReportsTamper(evidence)).toBe(false);
  });

  it('reports an opened case and a tamper loop that broke', async () => {
    const board = new MockBoard();
    const client = connect(board);
    const seal = new CompositeSeal({ nfc: client, enclosure: client });
    board.enclosure = { closed: false, openCount: 3 };
    expect(sealReportsTamper((await seal.capture()).evidence)).toBe(true);
    board.enclosure = { closed: true, openCount: 3 };
    board.nfc = { uid: '0x04112233445566', type: 'ntag213tt', tamper: 'open' };
    const { evidence } = await seal.capture();
    expect(evidence.nfc).toEqual({ uid: '0x04112233445566', tagType: 'ntag213tt', tamper: 'open' });
    expect(evidence.enclosure).toEqual({ closed: true, openCount: 3 });
    expect(sealReportsTamper(evidence)).toBe(true);
  });

  it('treats a seal tag that is no longer there as tampering', async () => {
    const board = new MockBoard();
    board.nfc = null;
    const { evidence, photo } = await new CompositeSeal({ nfc: connect(board) }).capture();
    expect(photo).toBeUndefined();
    expect(evidence.nfc).toEqual({ uid: '0x00', tagType: 'absent', tamper: 'open' });
    expect(sealReportsTamper(evidence)).toBe(true);
  });

  it('uses the newest picture of a folder when the board has no camera', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pinky-photos-'));
    writeFileSync(join(folder, 'old.jpg'), 'old picture');
    writeFileSync(join(folder, 'new.png'), 'new picture');
    writeFileSync(join(folder, 'notes.txt'), 'not a picture');
    utimesSync(join(folder, 'old.jpg'), new Date(NOW * 1000), new Date(NOW * 1000));
    utimesSync(join(folder, 'new.png'), new Date((NOW + 60) * 1000), new Date((NOW + 60) * 1000));
    const { evidence, photo } = await new CompositeSeal({ photo: filePhoto(folder) }).capture();
    expect(new TextDecoder().decode(photo!.bytes)).toBe('new picture');
    expect(evidence.photo).toMatchObject({ mime: 'image/png', source: 'file' });
    await expect(new CompositeSeal({ photo: filePhoto(join(folder, 'missing.jpg')) }).capture()).rejects.toThrow(/no seal photo/);
    await expect(new CompositeSeal({ photo: filePhoto(join(folder, 'notes.txt')) }).capture()).rejects.toThrow(/supported image/);
  });

  it('needs at least one source of evidence', () => {
    expect(() => new CompositeSeal({})).toThrow(/no source of seal evidence/);
  });
});

describe('venue anchor on a board', () => {
  const request = { device: `0x${'a1'.repeat(20)}` as Hex, blockhash: anchorBlock.blockHash };

  it('co-signs the nonce with the anchor board on its own port', async () => {
    const anchorBoard = new MockBoard({ role: 'anchor', venueId: 'WH-MUMBAI-01', highS: true });
    const anchor = new BoardAnchor(connect(anchorBoard));
    const first = verifyAnchorAttestation((await anchor.attest(request))!);
    const second = verifyAnchorAttestation((await anchor.attest(request))!);
    expect(first.signer).toBe(addressFromPublicKey(anchorBoard.publicKey));
    expect(first.attestation).toEqual({ venueId: 'WH-MUMBAI-01', device: request.device, blockhash: request.blockhash, counter: 1 });
    expect(second.attestation.counter).toBe(2);
  });

  it('is configured with its venue once', async () => {
    const anchorBoard = new MockBoard({ role: 'anchor' });
    const client = connect(anchorBoard);
    const problems: string[] = [];
    const anchor = new BoardAnchor(client, { onProblem: (reason) => problems.push(reason) });
    expect(await anchor.attest(request)).toBeNull();
    expect(problems[0]).toMatch(/no venue configured/);
    await expect(client.request('anchor.configure', { venue_id: 'not a valid id!' })).rejects.toThrow(/bad venue_id/);
    await client.request('anchor.configure', { venue_id: 'DOCK-7' });
    expect((await client.request('anchor.info')).venue_id).toBe('DOCK-7');
    expect(verifyAnchorAttestation((await anchor.attest(request))!).attestation.venueId).toBe('DOCK-7');
  });

  it('is reached through the device board over BLE, and is simply absent out of range', async () => {
    const anchorBoard = new MockBoard({ role: 'anchor', venueId: 'WH-MUMBAI-01' });
    const deviceBoard = new MockBoard({ bleAnchor: anchorBoard });
    const problems: string[] = [];
    const anchor = new BoardAnchor(connect(deviceBoard), { onProblem: (reason) => problems.push(reason) });
    expect((await connect(deviceBoard).info()).has.anchor).toBe(true);
    expect(verifyAnchorAttestation((await anchor.attest(request))!).signer).toBe(addressFromPublicKey(anchorBoard.publicKey));
    anchorBoard.unplug();
    expect(await anchor.attest(request)).toBeNull();
    expect(problems).toEqual(['board: anchor.attest: no anchor in range']);
  });

  it('never passes on an attestation the anchor key did not sign', async () => {
    const anchorBoard = new MockBoard({ role: 'anchor', venueId: 'WH-MUMBAI-01' });
    const client = connect(anchorBoard);
    const honest = client.request.bind(client);
    // A relay that swaps the public key for its own.
    client.request = (async (command: any, params: any, timeout: any) => {
      const answer: any = await honest(command, params, timeout);
      return command === 'anchor.attest' ? { ...answer, pubkey: toHex(new MockBoard().publicKey).slice(2) } : answer;
    }) as typeof client.request;
    const problems: string[] = [];
    expect(await new BoardAnchor(client, { onProblem: (reason) => problems.push(reason) }).attest(request)).toBeNull();
    expect(problems[0]).toMatch(/expected key/);
  });
});

describe('planning which parts are real', () => {
  it('uses whatever the board reports and simulates the rest', async () => {
    const board = new MockBoard({ parts: { atecc608b: false, gps: false, camera: false, pn532: false, enclosure: false } });
    const plan = planFor(await connect(board).info());
    expect(plan).toEqual({
      secureElement: 'sim',
      wallet: 'board',
      climate: 'board',
      position: 'sim',
      photo: 'sim',
      nfc: 'none',
      enclosure: 'none',
      anchor: 'sim',
      display: 'board',
    });
  });

  it('keeps named parts simulated, and takes photos from a folder when asked', async () => {
    const info = await connect(new MockBoard()).info();
    const plan = planFor(info, { simulate: ['wallet', 'gps', 'led'], photoFile: '/photos', anchorBoard: true });
    expect(plan).toMatchObject({
      secureElement: 'board',
      wallet: 'sim',
      climate: 'board',
      position: 'sim',
      photo: { file: '/photos' },
      nfc: 'board',
      enclosure: 'board',
      anchor: 'board',
      display: 'host',
    });
    expect(describePlan(plan).find((row) => row.part.startsWith('seal photo'))?.source).toBe('file (/photos)');
  });

  it('simulates everything when there is no board, or only an anchor board', async () => {
    expect(planFor(undefined)).toEqual(SIMULATED_PLAN);
    const anchorInfo = await connect(new MockBoard({ role: 'anchor', venueId: 'DOCK-7' })).info();
    expect(planFor(anchorInfo)).toEqual(SIMULATED_PLAN);
  });

  it('says what is missing instead of silently simulating it', () => {
    expect(() => assembleHardware({ ...SIMULATED_PLAN, climate: 'board' }, { identity: generateIdentity() })).toThrow(
      /SHT31 on a board, but no board is connected/,
    );
    expect(() => assembleHardware(SIMULATED_PLAN)).toThrow(/needs a simulated identity/);
  });
});

describe('a device assembled from parts', () => {
  const config = { registry, attestor, arkivChainId: 1337 };
  const profileFor = (address: Hex) =>
    signLotProfile(
      {
        assetId: 'LOT-42',
        device: address,
        tempMinCenti: 200,
        tempMaxCenti: 800,
        rhMinCenti: 2000,
        rhMaxCenti: 7000,
        validUntil: NOW + 30 * 86_400,
      },
      registrySecret,
    );
  const clock = () => {
    let t = NOW;
    return { now: () => t++ };
  };

  it('runs entirely on a board: certificate, reading, checkpoint with the anchor', async () => {
    const anchorBoard = new MockBoard({ role: 'anchor', venueId: 'WH-MUMBAI-01' });
    const board = new MockBoard({ highS: true });
    board.climate = { tempCenti: 425, rhCenti: 4550 };
    board.gps = { latDeg: 19.0761, lonDeg: 72.8778 };
    const client = connect(board);
    const { hardware, sim, display } = assembleHardware(planFor(await client.info(), { anchorBoard: true }), {
      board: client,
      anchorBoard: connect(anchorBoard),
      clock: clock(),
    });
    expect(sim).toEqual({});

    const device = await Device.create(hardware, new MemoryStorage(), config);
    expect(device.address).toBe(addressFromPublicKey(board.publicKey));
    device.setProfile(profileFor(device.address));

    const cert = verifyDeviceCert(await device.certificate());
    expect(cert.cert.device).toBe(device.address);
    expect(cert.cert.hwPubkey).toBe(toHex(await hardware.secureElement.publicKey()));

    const reading = await device.takeReading(anchorBlock);
    const verified = verifyReading(reading);
    // verifyReading throws unless the device named in the payload made the signature.
    expect(verified.reading).toMatchObject({ device: device.address, tempCenti: 425, rhCenti: 4550, seq: 1 });
    expect(reading.opening).toMatchObject({ latUnits: 1_090_761_000, lonUnits: 2_528_778_000 });
    expect(verified.reading.gpsCommitment).toBe(
      toHex(gpsCommitment({ latUnits: 1_090_761_000, lonUnits: 2_528_778_000, salt: fromHex(reading.opening!.salt) })),
    );

    const request = await device.takeCheckpoint(CheckpointKind.WAREHOUSE_IN, anchorBlock);
    const checkpoint = verifyCheckpoint(request);
    expect(checkpoint.checkpoint.device).toBe(device.address);
    const evidence = decodeSealEvidence(new Uint8Array(Buffer.from(request.seal, 'base64')));
    expect(evidence.photo?.source).toBe('device-camera');
    expect(evidence.nfc?.uid).toBe('0x04a1b2c3d4e5f6');
    expect(evidence.enclosure).toEqual({ closed: true, openCount: 0 });
    const attestation = verifyAnchorAttestation(request.anchor!);
    expect(attestation.signer).toBe(addressFromPublicKey(anchorBoard.publicKey));
    expect(checkpoint.checkpoint.anchorDigest).toBe(toHex(attestation.digest));

    // The board's LED was told the handoff is not accepted yet.
    await expect.poll(() => board.shown.at(-1)).toMatchObject({ state: 'PENDING' });
    expect(display.last.state).toBe('PENDING');
  });

  it('mixes one real part with simulated ones, and each can be steered or read on its own', async () => {
    const board = new MockBoard({ parts: { atecc608b: false, gps: false, camera: false, pn532: false, enclosure: false } });
    board.climate = { tempCenti: 1210, rhCenti: 4000 };
    const client = connect(board);
    const identity = generateIdentity();
    const venue = new SimulatedAnchor(`0x${'33'.repeat(32)}`);
    venue.setVenue('WH-MUMBAI-01');
    const { hardware, sim, plan } = assembleHardware(planFor(await client.info(), { simulate: ['wallet'] }), {
      board: client,
      identity,
      simulatedAnchor: venue,
      clock: clock(),
    });
    expect(plan).toMatchObject({ climate: 'board', wallet: 'sim', secureElement: 'sim', photo: 'sim' });
    expect(sim.climate).toBeUndefined();
    sim.position!.set({ latDeg: 19.0761, lonDeg: 72.8778 });
    sim.seal!.condition = 'broken';

    const device = await Device.create(hardware, new MemoryStorage(), config);
    expect(device.address).toBe(secpAddress(fromHex(identity.walletSecret)));
    device.setProfile(profileFor(device.address));
    // The temperature is the board's (12.10 °C), the position and the seal are the simulator's.
    expect(verifyReading(await device.takeReading(anchorBlock)).reading.tempCenti).toBe(1210);
    const request = await device.takeCheckpoint(CheckpointKind.DOCK_HANDOFF, anchorBlock);
    expect(decodeSealEvidence(new Uint8Array(Buffer.from(request.seal, 'base64'))).photo?.source).toBe('simulated');
    expect(verifyAnchorAttestation(request.anchor!).signer).toBe(venue.address);
  });

  it('carries on without a venue anchor, and stops when a sensor fails', async () => {
    const board = new MockBoard();
    const client = connect(board);
    const { hardware } = assembleHardware(planFor(await client.info()), { board: client, clock: clock() });
    const device = await Device.create(hardware, new MemoryStorage(), config);
    device.setProfile(profileFor(device.address));
    await device.takeReading(anchorBlock);
    // No anchor in range: the checkpoint is still taken, with an empty anchor field.
    const request = await device.takeCheckpoint(CheckpointKind.WAREHOUSE_OUT, anchorBlock);
    expect(request.anchor).toBeUndefined();
    expect(verifyCheckpoint(request).checkpoint.anchorDigest).toBe(ZERO_32);

    // A dead sensor is an error, never a made-up value — and no sequence number is spent on it.
    board.breakPart('climate.read', 'sht31 crc');
    const before = device.seq;
    await expect(device.takeReading(anchorBlock)).rejects.toThrow(/sht31 crc/);
    expect(device.seq).toBe(before);
  });
});
