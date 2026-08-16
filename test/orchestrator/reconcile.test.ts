import { describe, expect, it } from 'vitest';
import { reconcileTick } from '../../src/orchestrator/reconcile.js';
import { position } from '../helpers/fixtures.js';
import type { OpenOrder } from '../../src/exchange/types.js';
import type {
  PlacedExitOrderSnapshot,
  PlacedGridOrderSnapshot,
} from '../../src/orchestrator/reconcileTypes.js';

function grid(overrides: Partial<PlacedGridOrderSnapshot> = {}): PlacedGridOrderSnapshot {
  return {
    clientOrderId: 'deal-1-1',
    rungIndex: 1,
    price: 1897.74,
    size: 0.018,
    filledSize: 0,
    ...overrides,
  };
}

function exit(overrides: Partial<PlacedExitOrderSnapshot> = {}): PlacedExitOrderSnapshot {
  return {
    clientOrderId: 'deal-1-tp',
    type: 'tp',
    amount: 0.018,
    filledSize: 0,
    ...overrides,
  };
}

function openOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: 'ex-1',
    clientOrderId: 'deal-1-1',
    side: 'buy',
    price: 1897.74,
    amount: 0.018,
    filled: 0,
    status: 'open',
    reduceOnly: false,
    ...overrides,
  };
}

describe('reconcileTick — grid rung fills', () => {
  it('classifies a full fill: rung disappeared, contracts increased by exactly its size', () => {
    const events = reconcileTick({
      gridOrders: [grid()],
      exitOrders: [],
      previousContracts: 0,
      openOrders: [],
      position: position({ contracts: 0.018 }),
    });

    expect(events).toEqual([
      { kind: 'rung_filled', clientOrderId: 'deal-1-1', rungIndex: 1, fillPrice: 1897.74 },
    ]);
  });

  it('classifies a partial fill on a still-resting rung as observed progress, not a fill', () => {
    const events = reconcileTick({
      gridOrders: [grid({ size: 0.018, filledSize: 0 })],
      exitOrders: [],
      previousContracts: 0,
      openOrders: [openOrder({ filled: 0.007 })],
      position: position({ contracts: 0.007 }),
    });

    expect(events).toEqual([
      { kind: 'partial_fill', side: 'grid', clientOrderId: 'deal-1-1', filledSize: 0.007 },
    ]);
  });

  it('completes a previously partial fill once the remainder is explained by the position delta', () => {
    const events = reconcileTick({
      gridOrders: [grid({ size: 0.018, filledSize: 0.007 })],
      exitOrders: [],
      previousContracts: 0.007,
      openOrders: [], // now gone -> resolved
      position: position({ contracts: 0.018 }),
    });

    expect(events).toEqual([
      { kind: 'rung_filled', clientOrderId: 'deal-1-1', rungIndex: 1, fillPrice: 1897.74 },
    ]);
  });

  it('classifies a clean external cancel: rung disappeared, contracts unchanged', () => {
    const events = reconcileTick({
      gridOrders: [grid()],
      exitOrders: [],
      previousContracts: 0,
      openOrders: [],
      position: position({ contracts: 0 }),
    });

    expect(events).toEqual([{ kind: 'rung_cancelled', clientOrderId: 'deal-1-1', rungIndex: 1 }]);
  });

  it('classifies a cancel of the remainder after a real partial fill (previous partial already accounted for)', () => {
    // Rung partially filled to 0.01 in an earlier tick (already reflected in
    // previousContracts); this tick it disappears with NO further position
    // change -> the unfilled remainder was cancelled, not filled.
    const events = reconcileTick({
      gridOrders: [grid({ size: 0.018, filledSize: 0.01 })],
      exitOrders: [],
      previousContracts: 0.01,
      openOrders: [],
      position: position({ contracts: 0.01 }),
    });

    expect(events).toEqual([{ kind: 'rung_cancelled', clientOrderId: 'deal-1-1', rungIndex: 1 }]);
  });

  it('flags an ambiguous partial-then-partially-explained disappearance as diverged, not a guessed fill', () => {
    // Filled to 0.01 previously; disappeared now, but the position only grew
    // by 0.003 more (0.008 of the 0.008 remaining is NOT fully explained) —
    // cannot safely conclude it fully filled OR that nothing more happened.
    const events = reconcileTick({
      gridOrders: [grid({ size: 0.018, filledSize: 0.01 })],
      exitOrders: [],
      previousContracts: 0.01,
      openOrders: [],
      position: position({ contracts: 0.013 }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('position_diverged');
  });

  it('attributes several simultaneous full fills in rungIndex order (grid is monotonic in price)', () => {
    const rung1 = grid({ clientOrderId: 'deal-1-1', rungIndex: 1, price: 1897.74, size: 0.018 });
    const rung2 = grid({ clientOrderId: 'deal-1-2', rungIndex: 2, price: 1874.16, size: 0.019 });

    const events = reconcileTick({
      gridOrders: [rung2, rung1], // deliberately out of order
      exitOrders: [],
      previousContracts: 0,
      openOrders: [],
      position: position({ contracts: 0.018 + 0.019 }),
    });

    expect(events).toEqual([
      { kind: 'rung_filled', clientOrderId: 'deal-1-1', rungIndex: 1, fillPrice: 1897.74 },
      { kind: 'rung_filled', clientOrderId: 'deal-1-2', rungIndex: 2, fillPrice: 1874.16 },
    ]);
  });

  it('flags a leftover position increase that no disappeared or resting rung explains', () => {
    const events = reconcileTick({
      gridOrders: [],
      exitOrders: [],
      previousContracts: 0,
      openOrders: [],
      position: position({ contracts: 0.05 }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'position_diverged' });
  });
});

describe('reconcileTick — exit order fills', () => {
  it('classifies a TP fill: exit order disappeared, contracts dropped to exactly explain it', () => {
    const events = reconcileTick({
      gridOrders: [],
      exitOrders: [exit({ clientOrderId: 'deal-1-tp', type: 'tp', amount: 0.018 })],
      previousContracts: 0.018,
      openOrders: [],
      position: position({ contracts: 0 }),
    });

    expect(events).toEqual([{ kind: 'exit_filled', clientOrderId: 'deal-1-tp', exitType: 'tp' }]);
  });

  it('classifies an external cancel of a resting exit order (contracts unchanged)', () => {
    const events = reconcileTick({
      gridOrders: [],
      exitOrders: [exit({ clientOrderId: 'deal-1-tp', type: 'tp', amount: 0.018 })],
      previousContracts: 0.018,
      openOrders: [],
      position: position({ contracts: 0.018 }),
    });

    expect(events).toEqual([
      { kind: 'exit_cancelled', clientOrderId: 'deal-1-tp', exitType: 'tp' },
    ]);
  });

  it('detects the SL fill when SL disappears and TP is still resting', () => {
    const tp = exit({ clientOrderId: 'deal-1-tp', type: 'tp', amount: 0.018 });
    const sl = exit({ clientOrderId: 'deal-1-sl', type: 'sl', amount: 0.018 });

    const events = reconcileTick({
      gridOrders: [],
      exitOrders: [tp, sl],
      previousContracts: 0.018,
      openOrders: [openOrder({ clientOrderId: 'deal-1-tp', side: 'sell', filled: 0 })],
      position: position({ contracts: 0 }),
    });

    expect(events).toEqual([{ kind: 'exit_filled', clientOrderId: 'deal-1-sl', exitType: 'sl' }]);
  });

  it('flags an unexplained flatten (liquidation/manual close) when neither TP nor SL disappeared as filled', () => {
    const tp = exit({ clientOrderId: 'deal-1-tp', type: 'tp', amount: 0.018 });
    const sl = exit({ clientOrderId: 'deal-1-sl', type: 'sl', amount: 0.018 });

    const events = reconcileTick({
      gridOrders: [],
      exitOrders: [tp, sl],
      previousContracts: 0.018,
      openOrders: [
        openOrder({ clientOrderId: 'deal-1-tp', side: 'sell', filled: 0 }),
        openOrder({ clientOrderId: 'deal-1-sl', side: 'sell', filled: 0 }),
      ],
      position: position({ contracts: 0 }),
    });

    expect(events).toEqual([
      { kind: 'position_diverged', detail: expect.stringContaining('exit order') as string },
    ]);
  });
});

describe('reconcileTick — grid and exit sides are classified independently', () => {
  it('reports a clean grid fill and a clean exit-side classification from the same net position delta', () => {
    const tp = exit({ clientOrderId: 'deal-1-tp', type: 'tp', amount: 0.018 });

    const events = reconcileTick({
      gridOrders: [grid({ clientOrderId: 'deal-1-2', rungIndex: 2, price: 1874.16, size: 0.019 })],
      exitOrders: [tp],
      previousContracts: 0.018,
      // grid rung 2 fills (+0.019); TP also disappears, but the net delta is
      // entirely explained by the grid fill, so TP reads as a (confident)
      // external cancel, not an ambiguous divergence — each side resolves
      // independently from its own share of the same net delta.
      openOrders: [],
      position: position({ contracts: 0.018 + 0.019 }),
    });

    expect(events).toEqual([
      { kind: 'rung_filled', clientOrderId: 'deal-1-2', rungIndex: 2, fillPrice: 1874.16 },
      { kind: 'exit_cancelled', clientOrderId: 'deal-1-tp', exitType: 'tp' },
    ]);
  });
});
