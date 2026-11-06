/**
 * The custody state machine: what a decided checkpoint does to a lot.
 *
 * This is the rule set the Hedera contract enforces (contracts/src/CustodyOracle.sol). It lives
 * here as well so the gateway can tell what will happen before it spends gas and the buyer page
 * can explain what did happen. Shared test vectors keep the two implementations identical.
 *
 * Two guards make the AI's role safe:
 *
 * 1. Signatures, not the AI, certify readings. A freeze needs a REJECT *and* a device-signed
 *    out-of-range reading. A REJECT without one (say, a damaged seal) refuses the handoff but
 *    leaves the token alone.
 * 2. The AI cannot wave a breach through. An ACCEPT_CUSTODY while a breach is on record changes
 *    nothing; a person has to look.
 */
import { CheckpointKind, type CheckpointKindValue } from './checkpoint';
import { Decision, type DecisionValue } from './attestation';

/** The numeric values are the contract's `LotState` enum. */
export const LotState = {
  NONE: 0,
  /** Known to the oracle, no custody accepted yet. Nothing can be minted or moved. */
  REGISTERED: 1,
  /** A venue has accepted custody. The receipt can be issued and traded. */
  IN_CUSTODY: 2,
  /** On the road between venues. Transfers are restricted. */
  IN_TRANSIT: 3,
  /** Breach confirmed. Every holder's units are frozen until an inspector releases the lot. */
  FROZEN: 4,
  /** Delivered. Holders redeem their units. */
  DELIVERED: 5,
} as const;
export type LotStateName = keyof typeof LotState;
export type LotStateValue = (typeof LotState)[LotStateName];

export function lotStateName(value: number): LotStateName {
  const entry = Object.entries(LotState).find(([, v]) => v === value);
  if (!entry) throw new Error(`unknown lot state ${value}`);
  return entry[0] as LotStateName;
}

/** What a checkpoint did. The numeric values are the contract's `Outcome` enum. */
export const Outcome = {
  /** Custody accepted; the lot moved to its next state. */
  ACCEPTED: 1,
  /** Handoff refused; the lot stays where it was and the token is untouched. */
  REFUSED: 2,
  /** Breach confirmed; holders' units are frozen. */
  FROZEN: 3,
  /** The model asked for a human; nothing changed. */
  ESCALATED: 4,
  /** The model said accept, but a breach is on record; nothing changed. */
  BLOCKED_BY_BREACH: 5,
} as const;
export type OutcomeName = keyof typeof Outcome;
export type OutcomeValue = (typeof Outcome)[OutcomeName];

export function outcomeName(value: number): OutcomeName {
  const entry = Object.entries(Outcome).find(([, v]) => v === value);
  if (!entry) throw new Error(`unknown outcome ${value}`);
  return entry[0] as OutcomeName;
}

export type PolicyInput = {
  state: LotStateValue;
  /** A breach reported earlier and not yet cleared by an inspector. */
  breachOpen: boolean;
  kind: CheckpointKindValue;
  decision: DecisionValue;
  /** A device-signed out-of-range reading from this checkpoint's window is being presented. */
  breachProven: boolean;
};

export type PolicyResult =
  | { ok: true; outcome: OutcomeValue; next: LotStateValue; breachOpen: boolean }
  | { ok: false; reason: string };

/** Whether transfers between holders are allowed in a state. Mirrors `canTransfer` on chain. */
export function isTradable(state: LotStateValue): boolean {
  return state === LotState.IN_CUSTODY;
}

/** Whether units can be redeemed in a state. */
export function isRedeemable(state: LotStateValue): boolean {
  return state === LotState.IN_CUSTODY || state === LotState.DELIVERED;
}

export function applyCheckpoint(input: PolicyInput): PolicyResult {
  const { state, kind, decision, breachProven } = input;
  if (state === LotState.NONE) return { ok: false, reason: 'lot is not registered' };
  if (state === LotState.DELIVERED) return { ok: false, reason: 'lot is already delivered' };
  if (decision === Decision.PENDING) return { ok: false, reason: 'a pending decision cannot be applied' };

  // Presenting signed breach evidence puts the breach on record whatever the decision is.
  const breachOpen = input.breachOpen || breachProven;

  if (decision === Decision.ESCALATE) {
    return { ok: true, outcome: Outcome.ESCALATED, next: state, breachOpen };
  }

  if (decision === Decision.REJECT) {
    if (breachOpen) return { ok: true, outcome: Outcome.FROZEN, next: LotState.FROZEN, breachOpen };
    return { ok: true, outcome: Outcome.REFUSED, next: state, breachOpen };
  }

  // ACCEPT_CUSTODY from here on.
  if (state === LotState.FROZEN) return { ok: false, reason: 'lot is frozen; an inspector must release it first' };
  if (breachOpen) return { ok: true, outcome: Outcome.BLOCKED_BY_BREACH, next: state, breachOpen };

  const next = nextStateOnAccept(state, kind);
  if (next === undefined) {
    return { ok: false, reason: `a ${kindLabel(kind)} checkpoint cannot be accepted while ${lotStateName(state)}` };
  }
  return { ok: true, outcome: Outcome.ACCEPTED, next, breachOpen };
}

function nextStateOnAccept(state: LotStateValue, kind: CheckpointKindValue): LotStateValue | undefined {
  switch (kind) {
    case CheckpointKind.WAREHOUSE_IN:
      return state === LotState.REGISTERED || state === LotState.IN_TRANSIT ? LotState.IN_CUSTODY : undefined;
    case CheckpointKind.DOCK_HANDOFF:
      return state === LotState.IN_TRANSIT ? LotState.IN_CUSTODY : undefined;
    case CheckpointKind.WAREHOUSE_OUT:
      return state === LotState.IN_CUSTODY ? LotState.IN_TRANSIT : undefined;
    case CheckpointKind.FINAL_DELIVERY:
      return state === LotState.IN_CUSTODY || state === LotState.IN_TRANSIT ? LotState.DELIVERED : undefined;
    default:
      return undefined;
  }
}

function kindLabel(kind: CheckpointKindValue): string {
  return Object.entries(CheckpointKind).find(([, v]) => v === kind)?.[0] ?? `kind ${kind}`;
}
