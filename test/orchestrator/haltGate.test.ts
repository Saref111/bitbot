import { describe, expect, it } from 'vitest';
import { advanceHaltGate, haltSignature } from '../../src/orchestrator/haltGate.js';
import type { HaltGateState } from '../../src/orchestrator/types.js';
import type { ReconcileEvent } from '../../src/orchestrator/reconcileTypes.js';

describe('haltSignature', () => {
  it('is null when there are no events at all', () => {
    expect(haltSignature([])).toBeNull();
  });

  it('is null when only non-halt-worthy events occurred', () => {
    const events: ReconcileEvent[] = [
      { kind: 'partial_fill', side: 'grid', clientOrderId: 'deal-1-1', filledSize: 0.005 },
      { kind: 'rung_filled', clientOrderId: 'deal-1-1', rungIndex: 1, fillPrice: 1897.74 },
      { kind: 'exit_filled', clientOrderId: 'deal-1-tp-0', exitType: 'tp' },
    ];
    expect(haltSignature(events)).toBeNull();
  });

  it('signs a single rung_cancelled by kind and clientOrderId', () => {
    const events: ReconcileEvent[] = [
      { kind: 'rung_cancelled', clientOrderId: 'deal-1-1', rungIndex: 1 },
    ];
    expect(haltSignature(events)).toBe('rung_cancelled:deal-1-1');
  });

  it('signs a single exit_cancelled by kind and clientOrderId', () => {
    const events: ReconcileEvent[] = [
      { kind: 'exit_cancelled', clientOrderId: 'deal-1-tp-0', exitType: 'tp' },
    ];
    expect(haltSignature(events)).toBe('exit_cancelled:deal-1-tp-0');
  });

  it('signs a position_diverged by its detail message', () => {
    const events: ReconcileEvent[] = [{ kind: 'position_diverged', detail: 'unexplained delta' }];
    expect(haltSignature(events)).toBe('diverged:unexplained delta');
  });

  it('ignores non-halt-worthy events mixed in alongside a halt-worthy one', () => {
    const events: ReconcileEvent[] = [
      { kind: 'rung_filled', clientOrderId: 'deal-1-2', rungIndex: 2, fillPrice: 1874.16 },
      { kind: 'rung_cancelled', clientOrderId: 'deal-1-1', rungIndex: 1 },
    ];
    expect(haltSignature(events)).toBe('rung_cancelled:deal-1-1');
  });

  it('combines several halt-worthy events into one sorted, stable signature', () => {
    const events: ReconcileEvent[] = [
      { kind: 'exit_cancelled', clientOrderId: 'deal-1-sl-0', exitType: 'sl' },
      { kind: 'rung_cancelled', clientOrderId: 'deal-1-1', rungIndex: 1 },
    ];
    // Order-independent: same set of events in either order produces the same signature.
    const reversed = [...events].reverse();
    expect(haltSignature(events)).toBe(haltSignature(reversed));
    expect(haltSignature(events)).toBe('exit_cancelled:deal-1-sl-0|rung_cancelled:deal-1-1');
  });
});

describe('advanceHaltGate', () => {
  it('returns false and stays at streak 0 for a null signature (nothing anomalous this tick)', () => {
    const gate: HaltGateState = { lastSignature: null, streak: 0 };
    expect(advanceHaltGate(gate, null, 2)).toBe(false);
    expect(gate).toEqual({ lastSignature: null, streak: 0 });
  });

  it('resets an in-progress streak back to 0 when the anomaly clears (null signature)', () => {
    const gate: HaltGateState = { lastSignature: 'rung_cancelled:deal-1-1', streak: 1 };
    expect(advanceHaltGate(gate, null, 2)).toBe(false);
    expect(gate).toEqual({ lastSignature: null, streak: 0 });
  });

  it('does not confirm on the first occurrence when threshold is above 1', () => {
    const gate: HaltGateState = { lastSignature: null, streak: 0 };
    expect(advanceHaltGate(gate, 'rung_cancelled:deal-1-1', 2)).toBe(false);
    expect(gate).toEqual({ lastSignature: 'rung_cancelled:deal-1-1', streak: 1 });
  });

  it('confirms once the SAME signature repeats threshold times in a row', () => {
    const gate: HaltGateState = { lastSignature: null, streak: 0 };
    expect(advanceHaltGate(gate, 'rung_cancelled:deal-1-1', 2)).toBe(false);
    expect(advanceHaltGate(gate, 'rung_cancelled:deal-1-1', 2)).toBe(true);
    expect(gate).toEqual({ lastSignature: 'rung_cancelled:deal-1-1', streak: 2 });
  });

  it('confirms immediately when threshold is 1', () => {
    const gate: HaltGateState = { lastSignature: null, streak: 0 };
    expect(advanceHaltGate(gate, 'position_diverged', 1)).toBe(true);
  });

  it('restarts the streak at 1 when the signature changes, rather than accumulating across different anomalies', () => {
    const gate: HaltGateState = { lastSignature: null, streak: 0 };
    expect(advanceHaltGate(gate, 'rung_cancelled:deal-1-1', 3)).toBe(false);
    expect(advanceHaltGate(gate, 'rung_cancelled:deal-1-1', 3)).toBe(false);
    // A DIFFERENT anomaly this tick — must not inherit the streak from the previous one.
    expect(advanceHaltGate(gate, 'exit_cancelled:deal-1-tp-0', 3)).toBe(false);
    expect(gate).toEqual({ lastSignature: 'exit_cancelled:deal-1-tp-0', streak: 1 });
  });

  it('keeps confirming (streak beyond threshold still returns true) once already past it', () => {
    const gate: HaltGateState = { lastSignature: 'position_diverged', streak: 5 };
    expect(advanceHaltGate(gate, 'position_diverged', 2)).toBe(true);
    expect(gate.streak).toBe(6);
  });
});
