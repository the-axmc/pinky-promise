/**
 * Puts a device together from simulated and real parts, one choice per part.
 *
 * This is the whole "connect the hardware later" story: the plan below starts with every part
 * simulated, and each part moves to `board` on the day it is wired up — or automatically, when
 * the board reports the part at boot (see {@link planFor}). Nothing else changes.
 */
import { type Hex, ProtocolError } from '@pinky/protocol';
import type { AnchorSource, Clock, DeviceHardware, DeviceStatus, SealSource } from '../seams';
import {
  RecordingDisplay,
  ScriptedClimate,
  ScriptedPosition,
  type SimulatedIdentity,
  SimulatedSeal,
  SimulatedSecureElement,
  SoftwareWallet,
  noAnchor,
  systemClock,
} from '../sim/hardware';
import type { BoardClient } from './client';
import {
  BoardAnchor,
  BoardClimate,
  BoardDisplay,
  BoardPosition,
  BoardSecureElement,
  BoardWallet,
  CompositeSeal,
  boardCamera,
  filePhoto,
  simulatedPhoto,
} from './hardware';
import type { BoardInfo } from './protocol';

/** Where each part of the device comes from. */
export type HardwarePlan = {
  /** ATECC608B. */
  secureElement: 'sim' | 'board';
  /** The secp256k1 device wallet. */
  wallet: 'sim' | 'board';
  /** SHT31. */
  climate: 'sim' | 'board';
  /** GPS module. `none`: every reading says "no fix". */
  position: 'sim' | 'board' | 'none';
  /** The seal photo: the simulator's pictures, the board's camera, a file or folder, or none. */
  photo: 'sim' | 'board' | 'none' | { file: string };
  /** PN532 reading an NFC seal tag. */
  nfc: 'board' | 'none';
  /** Tamper switch on the device's case. */
  enclosure: 'board' | 'none';
  /** Venue anchor: simulated, a real anchor (its own board, or relayed over BLE), or none. */
  anchor: 'sim' | 'board' | 'none';
  /** Where the status is shown: the host's log only, or the board's LED as well. */
  display: 'host' | 'board';
};

/** Every part simulated: the mock device. */
export const SIMULATED_PLAN: HardwarePlan = {
  secureElement: 'sim',
  wallet: 'sim',
  climate: 'sim',
  position: 'sim',
  photo: 'sim',
  nfc: 'none',
  enclosure: 'none',
  anchor: 'sim',
  display: 'host',
};

/** The names a person uses for the parts, on the command line and in docs/hardware.md. */
export const PART_NAMES = ['atecc', 'wallet', 'sht31', 'gps', 'camera', 'nfc', 'enclosure', 'anchor', 'led'] as const;
export type PartName = (typeof PART_NAMES)[number];

/**
 * The plan for a board: every part it reports is used, everything else stays simulated.
 * `simulate` keeps the named parts simulated even though the board has them; `anchorBoard`
 * says a separate anchor board is plugged in.
 */
export function planFor(
  info: BoardInfo | undefined,
  options: { simulate?: readonly PartName[]; anchorBoard?: boolean; photoFile?: string } = {},
): HardwarePlan {
  const keep = new Set(options.simulate ?? []);
  const has = info?.role === 'device' ? info.has : undefined;
  const real = (name: PartName, present: boolean | undefined) => Boolean(present) && !keep.has(name);
  return {
    secureElement: real('atecc', has?.atecc608b) ? 'board' : 'sim',
    wallet: real('wallet', has?.wallet) ? 'board' : 'sim',
    climate: real('sht31', has?.sht31) ? 'board' : 'sim',
    position: real('gps', has?.gps) ? 'board' : 'sim',
    photo: options.photoFile ? { file: options.photoFile } : real('camera', has?.camera) ? 'board' : 'sim',
    nfc: real('nfc', has?.pn532) ? 'board' : 'none',
    enclosure: real('enclosure', has?.enclosure) ? 'board' : 'none',
    anchor: real('anchor', options.anchorBoard || has?.anchor) ? 'board' : 'sim',
    display: real('led', has !== undefined) ? 'board' : 'host',
  };
}

export type HardwareSources = {
  /** The device board. Required when the plan puts any part on it. */
  board?: BoardClient;
  /** The anchor board on its own port. Without it, `anchor: 'board'` asks the device board. */
  anchorBoard?: BoardClient;
  /** Keys for the simulated secure element and wallet. Required when either is simulated. */
  identity?: SimulatedIdentity;
  /** The simulated venue anchor. Without it, `anchor: 'sim'` means "no anchor in range". */
  simulatedAnchor?: AnchorSource;
  clock?: Clock;
  /** A simulated NFC seal tag, for a fully simulated seal. */
  nfcUid?: Hex;
  /** Hears every status change. */
  onStatus?: (status: DeviceStatus) => void;
  /** Hears why a real anchor did not answer. */
  onAnchorProblem?: (reason: string) => void;
};

export type AssembledHardware = {
  hardware: DeviceHardware;
  plan: HardwarePlan;
  /** The simulated parts, for a scenario to steer. Absent where the part is real. */
  sim: { climate?: ScriptedClimate; position?: ScriptedPosition; seal?: SimulatedSeal };
  display: RecordingDisplay;
};

export function assembleHardware(plan: HardwarePlan, sources: HardwareSources = {}): AssembledHardware {
  const board = (part: string): BoardClient => {
    if (!sources.board) throw new ProtocolError(`the plan puts the ${part} on a board, but no board is connected`);
    return sources.board;
  };
  const identity = (part: string): SimulatedIdentity => {
    if (!sources.identity) throw new ProtocolError(`the plan simulates the ${part}, which needs a simulated identity`);
    return sources.identity;
  };
  const sim: AssembledHardware['sim'] = {};

  const secureElement =
    plan.secureElement === 'board'
      ? new BoardSecureElement(board('secure element'))
      : new SimulatedSecureElement(identity('secure element').hwSecret, identity('secure element').hwSerial);
  const wallet = plan.wallet === 'board' ? new BoardWallet(board('wallet')) : new SoftwareWallet(identity('wallet').walletSecret);

  const climate = plan.climate === 'board' ? new BoardClimate(board('SHT31')) : (sim.climate = new ScriptedClimate());

  let position: DeviceHardware['position'];
  if (plan.position === 'board') position = new BoardPosition(board('GPS'));
  else if (plan.position === 'none') position = { read: async () => null };
  else position = sim.position = new ScriptedPosition();

  let seal: SealSource;
  if (plan.photo === 'sim' && plan.nfc === 'none' && plan.enclosure === 'none') {
    seal = sim.seal = new SimulatedSeal(sources.nfcUid ? { nfcUid: sources.nfcUid } : {});
  } else {
    let photo;
    if (plan.photo === 'board') photo = boardCamera(board('camera'));
    else if (plan.photo === 'sim') photo = simulatedPhoto((sim.seal = new SimulatedSeal()));
    else if (plan.photo !== 'none') photo = filePhoto(plan.photo.file);
    seal = new CompositeSeal({
      ...(photo ? { photo } : {}),
      ...(plan.nfc === 'board' ? { nfc: board('PN532') } : {}),
      ...(plan.enclosure === 'board' ? { enclosure: board('enclosure switch') } : {}),
    });
  }

  let anchor: AnchorSource;
  if (plan.anchor === 'board') {
    anchor = new BoardAnchor(sources.anchorBoard ?? board('venue anchor'), {
      ...(sources.onAnchorProblem ? { onProblem: sources.onAnchorProblem } : {}),
    });
  } else if (plan.anchor === 'sim') anchor = sources.simulatedAnchor ?? noAnchor;
  else anchor = noAnchor;

  const recording = new RecordingDisplay(sources.onStatus);
  const display = plan.display === 'board' ? new BoardDisplay(board('status LED'), recording) : recording;

  return {
    hardware: { secureElement, wallet, climate, position, seal, anchor, clock: sources.clock ?? systemClock, display },
    plan,
    sim,
    display: recording,
  };
}

/** One line per part, for the log: what is real and what is simulated. */
export function describePlan(plan: HardwarePlan): Array<{ part: string; source: string }> {
  const photo = typeof plan.photo === 'object' ? `file (${plan.photo.file})` : plan.photo === 'board' ? 'board camera' : plan.photo;
  return [
    { part: 'secure element (ATECC608B)', source: plan.secureElement },
    { part: 'device wallet', source: plan.wallet },
    { part: 'climate (SHT31)', source: plan.climate },
    { part: 'position (GPS)', source: plan.position },
    { part: 'seal photo (camera)', source: photo },
    { part: 'seal tag (PN532)', source: plan.nfc },
    { part: 'enclosure switch', source: plan.enclosure },
    { part: 'venue anchor', source: plan.anchor },
    { part: 'status', source: plan.display === 'board' ? 'board LED + log' : 'log' },
  ];
}
