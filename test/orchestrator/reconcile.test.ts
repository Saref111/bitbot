import { describe, expect, it } from 'vitest';
import { contractsImpliedByDb, reconcileTick } from '../../src/orchestrator/reconcile.js';
import { position } from '../helpers/fixtures.js';
import type { OpenOrder } from '../../src/exchange/types.js';
import type { ExitOrderRow, GridOrderRow } from '../../src/storage/types.js';
import type {
  PlacedExitOrderSnapshot,
  PlacedGridOrderSnapshot,
} from '../../src/orchestrator/reconcileTypes.js';

function gridRow(overrides: Partial<GridOrderRow> = {}): GridOrderRow {
  return {
    id: 1,
    dealId: 'deal-1',
    rungIndex: 1,
    price: 1897.74,
    size: 0.018,
    clientOrderId: 'deal-1-1',
    status: 'pending',
    createdAt: 1000,
    placedAt: null,
    filledAt: null,
    cancelledAt: null,
    fillPrice: null,
    filledSize: 0,
    ...overrides,
  };
}

function exitRow(overrides: Partial<ExitOrderRow> = {}): ExitOrderRow {
  return {
    id: 1,
    dealId: 'deal-1',
    type: 'tp',
    clientOrderId: 'deal-1-tp-0',
    price: 2020,
    amount: 0.018,
    status: 'placed',
    createdAt: 1000,
    filledAt: null,
    cancelledAt: null,
    filledSize: 0,
    ...overrides,
  };
}

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

describe('contractsImpliedByDb', () => {
  it('is 0 for no rows at all', () => {
    expect(contractsImpliedByDb([], [])).toBe(0);
  });

  it('counts a filled grid row at its full size', () => {
    expect(contractsImpliedByDb([gridRow({ status: 'filled', size: 0.018 })], [])).toBe(0.018);
  });

  it('counts a placed (still-resting) grid row only by its observed filledSize, not its full size', () => {
    expect(
      contractsImpliedByDb([gridRow({ status: 'placed', size: 0.018, filledSize: 0.007 })], []),
    ).toBe(0.007);
  });

  it('ignores pending and cancelled grid rows', () => {
    const rows = [
      gridRow({ status: 'pending', size: 0.018 }),
      gridRow({ status: 'cancelled', size: 0.019, filledSize: 0.005 }),
    ];
    expect(contractsImpliedByDb(rows, [])).toBe(0);
  });

  it('subtracts a filled exit row at its full amount', () => {
    expect(
      contractsImpliedByDb(
        [gridRow({ status: 'filled', size: 0.018 })],
        [exitRow({ status: 'filled', amount: 0.018 })],
      ),
    ).toBe(0);
  });

  it('subtracts a placed exit row only by its observed filledSize', () => {
    expect(
      contractsImpliedByDb(
        [gridRow({ status: 'filled', size: 0.018 })],
        [exitRow({ status: 'placed', amount: 0.018, filledSize: 0.006 })],
      ),
    ).toBeCloseTo(0.012, 9);
  });

  it('ignores a cancelled exit row entirely', () => {
    expect(
      contractsImpliedByDb(
        [gridRow({ status: 'filled', size: 0.018 })],
        [exitRow({ status: 'cancelled', amount: 0.018 })],
      ),
    ).toBe(0.018);
  });

  it('sums several grid and exit rows together', () => {
    const grids = [
      gridRow({ clientOrderId: 'deal-1-1', status: 'filled', size: 0.018 }),
      gridRow({ clientOrderId: 'deal-1-2', status: 'placed', size: 0.019, filledSize: 0.004 }),
      gridRow({ clientOrderId: 'deal-1-3', status: 'pending', size: 0.02 }),
    ];
    const exits = [
      exitRow({ clientOrderId: 'deal-1-tp-0', type: 'tp', status: 'placed', filledSize: 0.003 }),
    ];
    expect(contractsImpliedByDb(grids, exits)).toBeCloseTo(0.018 + 0.004 - 0.003, 9);
  });
});
