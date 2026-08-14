import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
import { getGridOrdersByDeal } from '../../src/storage/gridOrderRepository.js';
import { getExitOrdersByDeal, insertExitOrder } from '../../src/storage/exitOrderRepository.js';
import { runDeal } from '../../src/orchestrator/runDeal.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ExchangeAdapter, MarketInfo, OpenOrder, Position } from '../../src/exchange/types.js';

const market: MarketInfo = {
  symbol: 'ETH/USDT:USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minNotional: 5,
};

function order(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: 'ex-1',
    clientOrderId: 'deal-1-1',
    side: 'buy',
    price: 1996,
    amount: 0.15,
    filled: 0,
    status: 'open',
    reduceOnly: false,
    ...overrides,
  };
}

function pos(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'ETH/USDT:USDT',
    side: 'long',
    contracts: 0,
    entryPrice: null,
    liquidationPrice: null,
    ...overrides,
  };
}

function candle(close: number) {
  return { openTime: 0, closeTime: 60_000, open: close, high: close, low: close, close };
}

function makeMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    setupSymbol: vi.fn().mockResolvedValue(undefined),
    getMarketInfo: vi.fn().mockResolvedValue(market),
    fetchOHLCV: vi.fn().mockResolvedValue([candle(2000)]),
    fetchPosition: vi.fn().mockResolvedValue(pos()),
    createOrder: vi.fn().mockImplementation((params: { clientOrderId: string }) =>
      Promise.resolve({
        id: `ex-${params.clientOrderId}`,
        clientOrderId: params.clientOrderId,
        status: 'open',
      }),
    ),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    cancelAll: vi.fn().mockResolvedValue(undefined),
    fetchFundingRate: vi.fn(),
    ...overrides,
  };
}

// projectGrid(config, 2000, dealId) with these grid params, exchange-ready
// against `market` above, is exactly: rung1 price=1996 size=0.15,
// rung2 price=1900 size=0.157 (verified once against the real computation;
// hand-picking these without verifying would risk a mismatch the reconcile
// budget check would flag as diverged instead of a clean fill).
function twoRungConfig(overrides: Parameters<typeof buildConfig>[0] = {}) {
  return buildConfig({
    deposit_usdt: 200,
    leverage: 3,
    grid: {
      orders: 2,
      overlap_pct: 5,
      indent_pct: 0.2,
      martingale_pct: 0,
      log_distribution: 1,
      partial_placement: null,
      runaway_cancel_pct: 0.5,
    },
    take_profit_pct: 1,
    stop_loss: null,
    ...overrides,
  });
}

describe('runDeal — happy path (MVP §5: GRID_PLACED -> ACTIVE -> SETTLING)', () => {
  it('places the grid, fills rung 1, places TP from the real avg, then closes on the TP fill', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-1' }),
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
      ])
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]) // rung1 filled
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
        order({
          clientOrderId: 'deal-1-tp-0',
          side: 'sell',
          price: 2015.96,
          amount: 0.15,
          reduceOnly: true,
        }),
      ])
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]); // TP filled

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(pos({ contracts: 0 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValue(pos({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    const result = await runDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(adapter.cancelAll).toHaveBeenCalledWith('ETH/USDT:USDT');
    expect(adapter.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOrderId: 'deal-1-tp-0',
        price: 1996 * 1.01,
        amount: 0.15,
        reduceOnly: true,
      }),
    );

    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('SETTLING');
    expect(deal?.closeReason).toBe('tp');

    const gridOrders = getGridOrdersByDeal(db, 'deal-1');
    expect(gridOrders.find((o) => o.rungIndex === 1)).toMatchObject({
      status: 'filled',
      fillPrice: 1996,
    });
    expect(gridOrders.find((o) => o.rungIndex === 2)).toMatchObject({ status: 'cancelled' });

    const exitOrders = getExitOrdersByDeal(db, 'deal-1');
    expect(exitOrders).toEqual([
      expect.objectContaining({
        clientOrderId: 'deal-1-tp-0',
        status: 'filled',
        price: 1996 * 1.01,
      }),
    ]);
  });
});

describe('runDeal — partial fills (MVP: real limit orders can fill incrementally)', () => {
  it('persists progress without acting on a partial fill, then completes it as a normal full fill', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    const fetchOpenOrders = vi
      .fn()
      // tick 1: both rungs resting, untouched.
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-1' }),
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
      ])
      // tick 2: rung1 partially fills to 0.05, still resting.
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-1', filled: 0.05 }),
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
      ])
      // tick 3: rung1 now fully gone (resolved) -> first fill -> ACTIVE.
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })])
      // tick 4 (ACTIVE): rung2 and the freshly-created TP both resting.
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
        order({
          clientOrderId: 'deal-1-tp-0',
          side: 'sell',
          reduceOnly: true,
          price: 1996 * 1.01,
          amount: 0.15,
        }),
      ])
      // tick 5: TP fills, closing the deal.
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]);

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(pos({ contracts: 0 }))
      .mockResolvedValueOnce(pos({ contracts: 0.05 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValue(pos({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    const result = await runDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    const rung1 = getGridOrdersByDeal(db, 'deal-1').find((o) => o.rungIndex === 1);
    expect(rung1?.status).toBe('filled');
    expect(rung1?.fillPrice).toBeCloseTo(1996, 9);
  });
});

describe('runDeal — partial_placement (MVP §4.3: only K rungs live at once)', () => {
  it('places only the first K rungs, then delivers the next one after a fill', async () => {
    const db = openDatabase();
    const config = twoRungConfig({
      grid: {
        orders: 2,
        overlap_pct: 5,
        indent_pct: 0.2,
        martingale_pct: 0,
        log_distribution: 1,
        partial_placement: 1,
        runaway_cancel_pct: 0.5,
      },
    });

    const fetchOpenOrders = vi
      .fn()
      // tick 1 (GRID_PLACED): only rung1 was placed (K=1), rung2 is still
      // 'pending' in DB and does not exist on the exchange yet.
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-1' })])
      // tick 2 (GRID_PLACED): rung1 has filled and disappeared; rung2 isn't
      // on the exchange yet either, since delivery happens as PART of this
      // tick's handling, after this fetchOpenOrders call.
      .mockResolvedValueOnce([])
      // tick 3 (ACTIVE): rung2 (just delivered) and TP are now both resting.
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
        order({
          clientOrderId: 'deal-1-tp-0',
          side: 'sell',
          reduceOnly: true,
          price: 1996 * 1.01,
          amount: 0.15,
        }),
      ])
      // tick 4 (ACTIVE): TP fills, closing the deal.
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]);

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(pos({ contracts: 0 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValue(pos({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    const result = await runDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    // rung1 (initial K=1 delivery), then TP (created as part of the first-fill
    // transition), then rung2 (delivered only after rung1 filled, in that order).
    expect(adapter.createOrder).toHaveBeenCalledTimes(3);
    expect(adapter.createOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ clientOrderId: 'deal-1-1' }),
    );
    expect(adapter.createOrder).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ clientOrderId: 'deal-1-2' }),
    );
  });
});

describe('runDeal — runaway-cancel (MVP §5: GRID_PLACED, before the first fill)', () => {
  it('cancels the grid and stops when price runs away before any fill', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    const adapter = makeMockAdapter({
      fetchOpenOrders: vi
        .fn()
        .mockResolvedValue([
          order({ clientOrderId: 'deal-1-1' }),
          order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
        ]),
      fetchPosition: vi.fn().mockResolvedValue(pos({ contracts: 0 })),
      fetchOHLCV: vi.fn().mockResolvedValue([candle(2011)]), // 2000 * 1.005 = 2010 -> 2011 breaches it
    });
    let t = 1000;

    const result = await runDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'runaway' });
    expect(adapter.cancelAll).toHaveBeenCalledWith('ETH/USDT:USDT');
    const gridOrders = getGridOrdersByDeal(db, 'deal-1');
    expect(gridOrders.every((o) => o.status === 'cancelled')).toBe(true);
    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('SETTLING');
    expect(deal?.closeReason).toBe('runaway');
  });

  it('does not runaway-cancel when a fill and the runaway threshold breach land in the same tick — the fill wins', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    const fetchOpenOrders = vi
      .fn()
      // tick 1: rung1 already gone (filled) on the very first observed tick.
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })])
      // tick 2 (now ACTIVE): rung2 and the freshly-created TP both resting.
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
        order({
          clientOrderId: 'deal-1-tp-0',
          side: 'sell',
          reduceOnly: true,
          price: 1996 * 1.01,
          amount: 0.15,
        }),
      ])
      // tick 3: TP fills, closing the deal.
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]);

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValue(pos({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({
      fetchOpenOrders,
      fetchPosition,
      // Price already breaches runaway on the very first tick — but since a
      // fill is ALSO detected on that same tick, reconcileTick runs first
      // and the fill must win; runaway must never even be consulted.
      fetchOHLCV: vi.fn().mockResolvedValue([candle(2500)]),
    });
    let t = 1000;

    const result = await runDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(adapter.fetchOHLCV).not.toHaveBeenCalled();
  });

  it('does not runaway-cancel on a PARTIAL first fill either — a partial position left untracked is worse than skipping one runaway check', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    const fetchOpenOrders = vi
      .fn()
      // tick 1: rung1 partially filled (0.05 of 0.15), still resting.
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-1', filled: 0.05 }),
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
      ])
      // tick 2: rung1 fully resolved -> ACTIVE.
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })])
      // tick 3 (ACTIVE): rung2 and the freshly-created TP both resting.
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
        order({
          clientOrderId: 'deal-1-tp-0',
          side: 'sell',
          reduceOnly: true,
          price: 1996 * 1.01,
          amount: 0.15,
        }),
      ])
      // tick 4: TP fills, closing the deal.
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]);

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(pos({ contracts: 0.05 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValueOnce(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }))
      .mockResolvedValue(pos({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({
      fetchOpenOrders,
      fetchPosition,
      // Price breaches runaway from tick 1 onward — must never matter once
      // any position (even partial) is open, so fetchOHLCV should never
      // even be called.
      fetchOHLCV: vi.fn().mockResolvedValue([candle(2500)]),
    });
    let t = 1000;

    const result = await runDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(adapter.fetchOHLCV).not.toHaveBeenCalled();
  });
});

describe('runDeal — external cancel with confirmation-gate (PLAN.md: REST is not one atomic snapshot)', () => {
  it('does not halt on a single anomalous tick, only once the same anomaly repeats haltConfirmationTicks times', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    let calls = 0;
    const fetchOpenOrders = vi.fn().mockImplementation((): Promise<OpenOrder[]> => {
      calls += 1;
      // rung1 gone from the very first observed tick, with contracts never
      // moving -> looks like an external cancel on every tick.
      return Promise.resolve([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]);
    });
    const adapter = makeMockAdapter({
      fetchOpenOrders,
      fetchPosition: vi.fn().mockResolvedValue(pos({ contracts: 0 })),
    });
    let t = 1000;

    const result = await runDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      options: { pollIntervalMs: 1, haltConfirmationTicks: 2 },
    });

    expect(result).toEqual({
      outcome: 'halted',
      reason: expect.stringContaining('rung_cancelled') as string,
    });
    expect(calls).toBeGreaterThanOrEqual(2); // needed at least 2 ticks to confirm before halting
    // HALTED must not leave resting orders unattended on the exchange.
    expect(adapter.cancelAll).toHaveBeenCalledWith('ETH/USDT:USDT');
    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('HALTED');
    expect(deal?.closeReason).toBe('error');
  });
});

describe('runDeal — tick mutations are transactional', () => {
  it('rolls back the whole tick (including the fill) if one of its DB writes fails partway through', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-1' }),
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
      ])
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]); // rung1 filled

    // Seed a colliding exit_order row (same clientOrderId runDeal will try
    // to insert for the fresh TP once rung 1 fills) right as the SECOND
    // fetchPosition call resolves — i.e. exactly when the fill-handling
    // transaction is about to run — forcing a UNIQUE violation partway
    // through it.
    let tick = 0;
    const fetchPosition = vi.fn().mockImplementation(() => {
      tick += 1;
      if (tick === 1) return Promise.resolve(pos({ contracts: 0 }));
      insertExitOrder(db, {
        dealId: 'deal-1',
        type: 'tp',
        clientOrderId: 'deal-1-tp-0',
        price: 1,
        amount: 1,
        createdAt: 1,
      });
      return Promise.resolve(pos({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }));
    });

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    await expect(
      runDeal({
        adapter,
        db,
        config,
        now: () => t++,
        dealId: 'deal-1',
        entryPrice: 2000,
        options: { pollIntervalMs: 1 },
      }),
    ).rejects.toThrow();

    // The exchange-side createOrder calls happen before the transaction and
    // are NOT rolled back (can't un-place a real order) — but the DB write
    // recording any of that tick's outcome must be all-or-nothing: rung 1
    // must still read 'placed', not a half-applied 'filled', and the deal
    // must still read GRID_PLACED, not ACTIVE.
    const rung1 = getGridOrdersByDeal(db, 'deal-1').find((o) => o.rungIndex === 1);
    expect(rung1?.status).toBe('placed');
    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('GRID_PLACED');
  });
});
