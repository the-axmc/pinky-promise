/**
 * Opens a device ready to run: connects the board (or boards) if there are any, decides part by
 * part what is real and what is simulated, loads the device's keys and state, and hands back a
 * Device. The command-line tool and the demo both start here, so a real board and the simulator
 * go through exactly the same code from this point on.
 *
 * What is kept in the data directory:
 *
 *   identity.json            keys of the simulated secure element and wallet (unused when both
 *                            are real: those keys never leave the board)
 *   provisioning.json        whose lot profiles and decisions this device trusts
 *   state-<address>.json     sequence counters, certificate, recent readings (the ESP32's NVS)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Hex, ProtocolError, toHex, verifyDeviceCert } from '@pinky/protocol';
import {
  type AssembledHardware,
  type HardwarePlan,
  type PartName,
  assembleHardware,
  describePlan,
  planFor,
} from './bridge/assemble';
import { BoardClient } from './bridge/client';
import { MockBoard } from './bridge/mock-board';
import type { BoardInfo } from './bridge/protocol';
import { openSerialTransport } from './bridge/serial';
import { Device, type DeviceConfig, type DeviceStorage } from './device';
import type { AnchorSource, Clock, DeviceStatus } from './seams';
import { type SimulatedIdentity, generateIdentity } from './sim/hardware';
import { FileStorage, MemoryStorage } from './storage';

export type SessionOptions = {
  /** Whose lot profiles and decisions the device trusts, and on which Arkiv chain it signs. */
  provisioning: DeviceConfig;
  /** Where keys and state live. Without it everything is in memory and gone at exit. */
  dataDir?: string;
  /** Serial port of the device board, or "mock" for the in-memory board. Omit for no board. */
  port?: string;
  /** Serial port of a venue-anchor board plugged into this machine, or "mock". */
  anchorPort?: string;
  /** Parts to keep simulated even though the board has them. */
  simulate?: readonly PartName[];
  /** Take seal photos from this file or folder (newest image) instead of a camera. */
  photos?: string;
  /** Stands in for a venue anchor when none is real. */
  simulatedAnchor?: AnchorSource;
  /** Weakest BLE signal (dBm) at which an anchor still counts as in range. */
  minAnchorRssi?: number;
  /**
   * Decides, per request, which anchor answers. It is handed the real anchor when there is one
   * (its own board, or the device board's BLE link). A scripted journey uses this to say "the
   * real anchor is at the origin; out on the road there is none".
   */
  wrapAnchor?: (real: AnchorSource | undefined) => AnchorSource;
  clock?: Clock;
  /** Hears progress and warnings. */
  log?: (line: string) => void;
  onStatus?: (status: DeviceStatus) => void;
  /** Use these in-memory boards for "mock" ports instead of fresh ones (tests, the demo). */
  mockBoard?: MockBoard;
  mockAnchorBoard?: MockBoard;
};

/** Moves whatever is not real hardware. Each call says whether there was something to move. */
export type Steering = {
  /** Sets the climate the sensor reports. False when the SHT31 is real. */
  climate(tempCenti: number, rhCenti: number): boolean;
  /** Sets the position, or null for no fix. False when the GPS is real. */
  position(fix: { latDeg: number; lonDeg: number } | null): boolean;
  /** Shows the camera an intact or a broken seal. False when the camera is real. */
  seal(condition: 'intact' | 'broken'): boolean;
};

export type DeviceSession = {
  device: Device;
  plan: HardwarePlan;
  /** Rows of "part → where it comes from", for the log. */
  parts: Array<{ part: string; source: string }>;
  boardInfo?: BoardInfo;
  board?: BoardClient;
  anchorBoard?: BoardClient;
  /** The in-memory boards, when "mock" ports were asked for. */
  mock?: MockBoard;
  mockAnchor?: MockBoard;
  steer: Steering;
  /** Where the device is right now according to its GPS (real or simulated); null = no fix. */
  position(): Promise<{ latDeg: number; lonDeg: number } | null>;
  lastStatus(): DeviceStatus;
  close(): Promise<void>;
};

async function connect(port: string, mock: MockBoard, log: (line: string) => void): Promise<BoardClient> {
  const onLog = (line: string) => log(`[board ${port}] ${line}`);
  if (port === 'mock') return new BoardClient(mock.transport, { onLog });
  return new BoardClient(await openSerialTransport(port), { onLog });
}

function loadIdentity(dataDir: string | undefined): SimulatedIdentity {
  if (!dataDir) return generateIdentity();
  const path = join(dataDir, 'identity.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as SimulatedIdentity;
  const identity = generateIdentity();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

export async function openDeviceSession(options: SessionOptions): Promise<DeviceSession> {
  const log = options.log ?? (() => {});
  const opened: BoardClient[] = [];
  try {
    let board: BoardClient | undefined;
    let boardInfo: BoardInfo | undefined;
    let mock: MockBoard | undefined;
    if (options.port) {
      if (options.port === 'mock') mock = options.mockBoard ?? new MockBoard();
      board = await connect(options.port, mock!, log);
      opened.push(board);
      boardInfo = await board.waitReady();
      if (boardInfo.role !== 'device') {
        throw new ProtocolError(`the board on ${options.port} is a venue anchor, not a device — pass it as the anchor port`);
      }
      log(`board on ${options.port}: ${boardInfo.board}, firmware ${boardInfo.fw}`);
    }

    let anchorBoard: BoardClient | undefined;
    let mockAnchor: MockBoard | undefined;
    if (options.anchorPort) {
      if (options.anchorPort === 'mock') mockAnchor = options.mockAnchorBoard ?? new MockBoard({ role: 'anchor' });
      anchorBoard = await connect(options.anchorPort, mockAnchor!, log);
      opened.push(anchorBoard);
      const anchorInfo = await anchorBoard.waitReady();
      if (anchorInfo.role !== 'anchor') throw new ProtocolError(`the board on ${options.anchorPort} is not a venue anchor`);
    }

    const plan = planFor(boardInfo, {
      ...(options.simulate ? { simulate: options.simulate } : {}),
      anchorBoard: anchorBoard !== undefined,
      ...(options.photos ? { photoFile: options.photos } : {}),
    });

    // A chip fresh from the bag answers on the bus but cannot sign until it is provisioned.
    if (plan.secureElement === 'board') {
      try {
        await board!.request('se.info');
      } catch (error) {
        log(`ATECC608B is not usable yet (${(error as Error).message}); simulating the secure element for now`);
        plan.secureElement = 'sim';
      }
    }

    const needsIdentity = plan.secureElement === 'sim' || plan.wallet === 'sim';
    const assembled: AssembledHardware = assembleHardware(plan, {
      ...(board ? { board } : {}),
      ...(anchorBoard ? { anchorBoard } : {}),
      ...(needsIdentity ? { identity: loadIdentity(options.dataDir) } : {}),
      ...(options.simulatedAnchor ? { simulatedAnchor: options.simulatedAnchor } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      ...(options.minAnchorRssi !== undefined ? { minAnchorRssi: options.minAnchorRssi } : {}),
      onAnchorProblem: (why) => log(`venue anchor: ${why}`),
    });

    if (options.wrapAnchor) {
      assembled.hardware.anchor = options.wrapAnchor(plan.anchor === 'board' ? assembled.hardware.anchor : undefined);
    }

    const address = await assembled.hardware.wallet.address();
    let storage: DeviceStorage = new MemoryStorage();
    if (options.dataDir) {
      mkdirSync(options.dataDir, { recursive: true });
      storage = new FileStorage(join(options.dataDir, `state-${address}.json`));
    }

    // The certificate binds this wallet to one secure element. If the element changed since
    // (for example a real ATECC608B replaced the simulated one), the stored certificate, and
    // the enrolment made with it, describe a device that no longer exists.
    const stored = storage.load()?.certBundle;
    if (stored) {
      const enrolledKey = verifyDeviceCert(stored).cert.hwPubkey;
      const currentKey: Hex = toHex(await assembled.hardware.secureElement.publicKey());
      if (enrolledKey !== currentKey) {
        throw new ProtocolError(
          `device ${address} was enrolled with a different secure element. A device's identity is fixed at enrolment: ` +
            'give it a new wallet (erase the board\'s flash, or use a new data directory for a simulated wallet) and enrol it again.',
        );
      }
    }

    const device = await Device.create(assembled.hardware, storage, options.provisioning);
    const { sim } = assembled;
    const steer: Steering = {
      climate(tempCenti, rhCenti) {
        if (sim.climate) sim.climate.set(tempCenti, rhCenti);
        else if (mock && plan.climate === 'board') mock.climate = { tempCenti: Math.round(tempCenti), rhCenti: Math.round(rhCenti) };
        else return false;
        return true;
      },
      position(fix) {
        if (sim.position) sim.position.set(fix);
        else if (mock && plan.position === 'board') mock.gps = fix;
        else return plan.position === 'none' && fix === null;
        return true;
      },
      seal(condition) {
        if (sim.seal) sim.seal.condition = condition;
        else if (mock && plan.photo === 'board') mock.showSeal(condition);
        else return false;
        return true;
      },
    };

    return {
      device,
      plan,
      parts: describePlan(plan),
      ...(boardInfo ? { boardInfo } : {}),
      ...(board ? { board } : {}),
      ...(anchorBoard ? { anchorBoard } : {}),
      ...(mock ? { mock } : {}),
      ...(mockAnchor ? { mockAnchor } : {}),
      steer,
      position: () => assembled.hardware.position.read(),
      lastStatus: () => assembled.display.last,
      async close() {
        await Promise.all(opened.map((client) => client.close()));
      },
    };
  } catch (error) {
    await Promise.allSettled(opened.map((client) => client.close()));
    throw error;
  }
}

/** Reads the device's provisioning from its data directory, or stores it on first use. */
export function loadProvisioning(dataDir: string, fresh: () => Promise<DeviceConfig>): Promise<DeviceConfig> {
  const path = join(dataDir, 'provisioning.json');
  if (existsSync(path)) return Promise.resolve(JSON.parse(readFileSync(path, 'utf8')) as DeviceConfig);
  return fresh().then((config) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2));
    return config;
  });
}
