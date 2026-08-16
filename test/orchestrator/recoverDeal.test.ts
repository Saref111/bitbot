import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { insertDeal, getDeal, updateDeal } from '../../src/storage/dealRepository.js';
import {
  insertGridOrders,
  updateGridOrderStatus,
  getGridOrdersByDeal,
} from '../../src/storage/gridOrderRepository.js';
import { insertExitOrder } from '../../src/storage/exitOrderRepository.js';
import { recoverDeal } from '../../src/orchestrator/recoverDeal.js';
import { defaultMarket as market, position, twoRungConfig } from '../helpers/fixtures.js';
import type { ExchangeAdapter, OpenOrder } from '../../src/exchange/types.js';

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

function makeMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    setupSymbol: vi.fn().mockResolvedValue(undefined),
    getMarketInfo: vi.fn().mockResolvedValue(market),
    fetchOHLCV: vi
      .fn()
      .mockResolvedValue([
        { openTime: 0, closeTime: 60_000, open: 2000, high: 2000, low: 2000, close: 2000 },
      ]),
    fetchPosition: vi.fn().mockResolvedValue(position()),
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
    fetchTrades: vi.fn().mockResolvedValue([]),
    fetchFundingHistory: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('recoverDeal — terminal / trivial statuses', () => {
  it('returns no-deal when the dealId does not exist', async () => {
    const db = openDatabase();
    const adapter = makeMockAdapter();

    const result = await recoverDeal({
      adapter,
      db,
      config: twoRungConfig(),
      now: () => 1000,
      dealId: 'nope',
    });

    expect(result).toEqual({ outcome: 'no-deal' });
    expect(adapter.fetchOpenOrders).not.toHaveBeenCalled();
  });

  it('returns the stored outcome for an already-SETTLING deal without touching the exchange', async () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'SETTLING',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 900,
    });
    updateDeal(db, 'deal-1', { closeReason: 'tp', closedAt: 950 });
    const adapter = makeMockAdapter();

    const result = await recoverDeal({
      adapter,
      db,
      config: twoRungConfig(),
      now: () => 1000,
      dealId: 'deal-1',
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(adapter.fetchOpenOrders).not.toHaveBeenCalled();
  });

  it('returns halted for an already-HALTED deal without touching the exchange', async () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'HALTED',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 900,
    });
    const adapter = makeMockAdapter();

    const result = await recoverDeal({
      adapter,
      db,
      config: twoRungConfig(),
      now: () => 1000,
      dealId: 'deal-1',
    });

    expect(result.outcome).toBe('halted');
    expect(adapter.fetchOpenOrders).not.toHaveBeenCalled();
  });

  it('halts a deal stuck in WAITING_SIGNAL (crashed before the grid was ever placed)', async () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 900,
    });
    const adapter = makeMockAdapter();

    const result = await recoverDeal({
      adapter,
      db,
      config: twoRungConfig(),
      now: () => 1000,
      dealId: 'deal-1',
    });

    expect(result.outcome).toBe('halted');
    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('HALTED');
    expect(deal?.closeReason).toBe('error');
    expect(adapter.fetchOpenOrders).not.toHaveBeenCalled();
  });
});

describe('recoverDeal — resumes GRID_PLACED (catches up on what happened during downtime)', () => {
  it('detects a fill that happened while the process was down, and drives the deal on to a close', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    insertDeal(db, {
      id: 'deal-1',
      status: 'GRID_PLACED',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 900,
    });
    updateDeal(db, 'deal-1', { pEntry: 2000 });
    insertGridOrders(
      db,
      'deal-1',
      [
        { rungIndex: 1, price: 1996, size: 0.15, clientOrderId: 'deal-1-1' },
        { rungIndex: 2, price: 1900, size: 0.157, clientOrderId: 'deal-1-2' },
      ],
      900,
    );
    updateGridOrderStatus(db, 'deal-1-1', { status: 'placed', placedAt: 900 });
    updateGridOrderStatus(db, 'deal-1-2', { status: 'placed', placedAt: 900 });

    const fetchOpenOrders = vi
      .fn()
      // rung1 already gone by the time we resume -> filled while we were down.
      // First call is recoverDeal's own orphan check (both grid rows are
      // already 'placed' in DB here, so it has nothing to promote/adopt);
      // the state doesn't change again before the first real tick reads it.
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })])
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })])
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
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]);

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(
        position({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }),
      )
      .mockResolvedValueOnce(
        position({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }),
      )
      .mockResolvedValue(position({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    const result = await recoverDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    const rung1 = getGridOrdersByDeal(db, 'deal-1').find((o) => o.rungIndex === 1);
    expect(rung1?.status).toBe('filled');
  });
});

describe('recoverDeal — resumes ACTIVE (catches up on what happened during downtime)', () => {
  it('detects a TP fill that happened while the process was down and closes the deal', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 900,
    });
    updateDeal(db, 'deal-1', { pEntry: 2000, filledRungsCount: 1 });
    insertGridOrders(
      db,
      'deal-1',
      [
        { rungIndex: 1, price: 1996, size: 0.15, clientOrderId: 'deal-1-1' },
        { rungIndex: 2, price: 1900, size: 0.157, clientOrderId: 'deal-1-2' },
      ],
      900,
    );
    updateGridOrderStatus(db, 'deal-1-1', { status: 'filled', filledAt: 910, fillPrice: 1996 });
    updateGridOrderStatus(db, 'deal-1-2', { status: 'placed', placedAt: 900 });
    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'tp',
      clientOrderId: 'deal-1-tp-0',
      price: 1996 * 1.01,
      amount: 0.15,
      createdAt: 910,
    });

    const adapter = makeMockAdapter({
      // TP already gone by the time we resume -> it filled while we were down.
      fetchOpenOrders: vi
        .fn()
        .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]),
      fetchPosition: vi.fn().mockResolvedValue(position({ contracts: 0, entryPrice: null })),
    });
    let t = 1000;

    const result = await recoverDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(adapter.cancelAll).toHaveBeenCalledWith('ETH/USDT:USDT');
    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('SETTLING');
    const rung2 = getGridOrdersByDeal(db, 'deal-1').find((o) => o.rungIndex === 2);
    expect(rung2?.status).toBe('cancelled'); // never filled, and TP closed the deal -> cancelled
  });
});

describe('recoverDeal — orphan reconciliation (exchange ahead of DB: createOrder happens before the tick commits)', () => {
  it('promotes a pending rung to placed when it is found resting live, then proceeds normally to a close', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    insertDeal(db, {
      id: 'deal-1',
      status: 'GRID_PLACED',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 900,
    });
    updateDeal(db, 'deal-1', { pEntry: 2000 });
    insertGridOrders(
      db,
      'deal-1',
      [
        { rungIndex: 1, price: 1996, size: 0.15, clientOrderId: 'deal-1-1' },
        { rungIndex: 2, price: 1900, size: 0.157, clientOrderId: 'deal-1-2' },
      ],
      900,
    );
    // Neither row was ever marked 'placed' — simulating a crash right after
    // rung 1's createOrder succeeded but before that tick's DB write landed.
    // Rung 2 genuinely never got created.

    const fetchOpenOrders = vi
      .fn()
      // Orphan check: rung 1 is resting live even though DB still says 'pending'.
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-1' })])
      // Tick 1 (GRID_PLACED): unchanged, no fill yet.
      .mockResolvedValueOnce([order({ clientOrderId: 'deal-1-1' })])
      // Tick 2: rung 1 gone -> filled while we were down.
      .mockResolvedValueOnce([])
      // Tick 3 (ACTIVE): rung 2 (delivered on the fill) and the fresh TP both resting.
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
      // Tick 4: TP fills, closing the deal.
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]);

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(position({ contracts: 0 }))
      .mockResolvedValueOnce(
        position({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }),
      )
      .mockResolvedValueOnce(
        position({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }),
      )
      .mockResolvedValue(position({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    const result = await recoverDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    // createOrder must NOT have been called again for rung 1 — it was
    // recognized as already live, not re-submitted.
    expect(adapter.createOrder).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: 'deal-1-1' }),
    );
    const gridOrders = getGridOrdersByDeal(db, 'deal-1');
    expect(gridOrders.find((o) => o.rungIndex === 1)).toMatchObject({
      status: 'filled',
      fillPrice: 1996,
    });
  });

  it('adopts an orphaned TP order that has no exit_order row at all yet', async () => {
    const db = openDatabase();
    const config = twoRungConfig();

    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 900,
    });
    updateDeal(db, 'deal-1', { pEntry: 2000, filledRungsCount: 1 });
    insertGridOrders(
      db,
      'deal-1',
      [
        { rungIndex: 1, price: 1996, size: 0.15, clientOrderId: 'deal-1-1' },
        { rungIndex: 2, price: 1900, size: 0.157, clientOrderId: 'deal-1-2' },
      ],
      900,
    );
    updateGridOrderStatus(db, 'deal-1-1', { status: 'filled', filledAt: 910, fillPrice: 1996 });
    updateGridOrderStatus(db, 'deal-1-2', { status: 'placed', placedAt: 900 });
    // Deliberately NO insertExitOrder — the crash happened between TP's
    // createOrder succeeding and the transaction that would have recorded it.

    const tpOnExchange = order({
      clientOrderId: 'deal-1-tp-0',
      side: 'sell',
      reduceOnly: true,
      price: 1996 * 1.01,
      amount: 0.15,
    });
    const fetchOpenOrders = vi
      .fn()
      // Orphan check + tick 1: TP resting live, unknown to the DB yet.
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
        tpOnExchange,
      ])
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 }),
        tpOnExchange,
      ])
      // Tick 2: TP fills, closing the deal.
      .mockResolvedValue([order({ clientOrderId: 'deal-1-2', price: 1900, amount: 0.157 })]);

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(
        position({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }),
      )
      .mockResolvedValueOnce(
        position({ contracts: 0.15, entryPrice: 1996, liquidationPrice: 1000 }),
      )
      .mockResolvedValue(position({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    const result = await recoverDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    // The TP must never have been re-created — it was adopted as already live.
    expect(adapter.createOrder).not.toHaveBeenCalled();
    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('SETTLING');
    expect(deal?.closeReason).toBe('tp');
  });
});
