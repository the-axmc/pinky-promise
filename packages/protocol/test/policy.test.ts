import { describe, expect, it } from 'vitest';
import {
  CheckpointKind,
  Decision,
  LotState,
  Outcome,
  applyCheckpoint,
  assetIdToBytes32,
  bytes32ToAssetId,
  isInRange,
  isRedeemable,
  isTradable,
  isValidIsin,
  isinCheckDigit,
  isinForLot,
  type PolicyInput,
} from '../src';

const base: PolicyInput = {
  state: LotState.IN_TRANSIT,
  breachOpen: false,
  kind: CheckpointKind.DOCK_HANDOFF,
  decision: Decision.ACCEPT_CUSTODY,
  breachProven: false,
};

describe('thresholds', () => {
  const band = { tempMinCenti: 200, tempMaxCenti: 800, rhMinCenti: 2000, rhMaxCenti: 7000 };

  it('treats the bounds as inclusive', () => {
    expect(isInRange(band, 200, 2000)).toBe(true);
    expect(isInRange(band, 800, 7000)).toBe(true);
    expect(isInRange(band, 199, 4500)).toBe(false);
    expect(isInRange(band, 801, 4500)).toBe(false);
    expect(isInRange(band, 500, 1999)).toBe(false);
    expect(isInRange(band, 500, 7001)).toBe(false);
  });
});

describe('custody state machine', () => {
  it('walks the happy path from registration to delivery', () => {
    let state = LotState.REGISTERED as PolicyInput['state'];
    const steps = [
      [CheckpointKind.WAREHOUSE_IN, LotState.IN_CUSTODY],
      [CheckpointKind.WAREHOUSE_OUT, LotState.IN_TRANSIT],
      [CheckpointKind.DOCK_HANDOFF, LotState.IN_CUSTODY],
      [CheckpointKind.WAREHOUSE_OUT, LotState.IN_TRANSIT],
      [CheckpointKind.FINAL_DELIVERY, LotState.DELIVERED],
    ] as const;
    for (const [kind, expected] of steps) {
      const result = applyCheckpoint({ ...base, state, kind });
      expect(result).toMatchObject({ ok: true, outcome: Outcome.ACCEPTED, next: expected });
      if (result.ok) state = result.next;
    }
  });

  it('freezes only when a REJECT meets a device-signed breach', () => {
    expect(applyCheckpoint({ ...base, decision: Decision.REJECT, breachProven: true })).toEqual({
      ok: true,
      outcome: Outcome.FROZEN,
      next: LotState.FROZEN,
      breachOpen: true,
    });
  });

  it('refuses the handoff but leaves the token alone on a REJECT without a breach', () => {
    expect(applyCheckpoint({ ...base, decision: Decision.REJECT })).toEqual({
      ok: true,
      outcome: Outcome.REFUSED,
      next: LotState.IN_TRANSIT,
      breachOpen: false,
    });
  });

  it('does not let the model accept custody over a breach', () => {
    expect(applyCheckpoint({ ...base, breachProven: true })).toEqual({
      ok: true,
      outcome: Outcome.BLOCKED_BY_BREACH,
      next: LotState.IN_TRANSIT,
      breachOpen: true,
    });
    // ...and the breach stays on record for the next checkpoint.
    expect(applyCheckpoint({ ...base, breachOpen: true })).toMatchObject({
      outcome: Outcome.BLOCKED_BY_BREACH,
    });
    expect(applyCheckpoint({ ...base, breachOpen: true, decision: Decision.REJECT })).toMatchObject({
      outcome: Outcome.FROZEN,
      next: LotState.FROZEN,
    });
  });

  it('changes nothing on ESCALATE, but records presented breach evidence', () => {
    expect(applyCheckpoint({ ...base, decision: Decision.ESCALATE })).toEqual({
      ok: true,
      outcome: Outcome.ESCALATED,
      next: LotState.IN_TRANSIT,
      breachOpen: false,
    });
    expect(applyCheckpoint({ ...base, decision: Decision.ESCALATE, breachProven: true })).toMatchObject({
      breachOpen: true,
    });
  });

  it('never applies a PENDING decision', () => {
    expect(applyCheckpoint({ ...base, decision: Decision.PENDING })).toMatchObject({ ok: false });
  });

  it('rejects transitions that make no physical sense', () => {
    const impossible: Array<[PolicyInput['state'], PolicyInput['kind']]> = [
      [LotState.REGISTERED, CheckpointKind.WAREHOUSE_OUT],
      [LotState.REGISTERED, CheckpointKind.DOCK_HANDOFF],
      [LotState.REGISTERED, CheckpointKind.FINAL_DELIVERY],
      [LotState.IN_CUSTODY, CheckpointKind.WAREHOUSE_IN],
      [LotState.IN_CUSTODY, CheckpointKind.DOCK_HANDOFF],
      [LotState.IN_TRANSIT, CheckpointKind.WAREHOUSE_OUT],
    ];
    for (const [state, kind] of impossible) {
      expect(applyCheckpoint({ ...base, state, kind })).toMatchObject({ ok: false });
    }
  });

  it('keeps a frozen lot frozen until an inspector releases it', () => {
    const frozen = { ...base, state: LotState.FROZEN, breachOpen: true };
    expect(applyCheckpoint(frozen)).toMatchObject({ ok: false });
    expect(applyCheckpoint({ ...frozen, decision: Decision.REJECT })).toMatchObject({
      next: LotState.FROZEN,
    });
    expect(applyCheckpoint({ ...frozen, decision: Decision.ESCALATE })).toMatchObject({
      next: LotState.FROZEN,
    });
  });

  it('accepts nothing for an unknown or closed lot', () => {
    expect(applyCheckpoint({ ...base, state: LotState.NONE })).toMatchObject({ ok: false });
    expect(applyCheckpoint({ ...base, state: LotState.DELIVERED })).toMatchObject({ ok: false });
  });

  it('allows trading only in custody, and redemption in custody or after delivery', () => {
    expect(Object.values(LotState).filter(isTradable)).toEqual([LotState.IN_CUSTODY]);
    expect(Object.values(LotState).filter(isRedeemable)).toEqual([LotState.IN_CUSTODY, LotState.DELIVERED]);
  });
});

describe('lot identifiers', () => {
  it('maps a lot id to a left-aligned bytes32 and back', () => {
    const value = assetIdToBytes32('LOT-42');
    expect(value).toBe(`0x4c4f542d3432${'00'.repeat(26)}`);
    expect(bytes32ToAssetId(value)).toBe('LOT-42');
  });

  it('computes ISIN check digits that match real, published ISINs', () => {
    for (const isin of ['US0378331005', 'US5949181045', 'GB0002634946', 'DE000BAY0017', 'AU0000XVGZA3']) {
      expect(isinCheckDigit(isin.slice(0, 11))).toBe(Number(isin[11]));
      expect(isValidIsin(isin)).toBe(true);
    }
    expect(isValidIsin('US0378331006')).toBe(false);
    expect(isValidIsin('us0378331005')).toBe(false);
  });

  it('derives a stable, well-formed identifier per lot in the user-assigned range', () => {
    const isin = isinForLot('LOT-42');
    expect(isin).toMatch(/^ZZ[A-Z0-9]{9}[0-9]$/);
    expect(isValidIsin(isin)).toBe(true);
    expect(isinForLot('LOT-42')).toBe(isin);
    expect(isinForLot('LOT-43')).not.toBe(isin);
  });
});
