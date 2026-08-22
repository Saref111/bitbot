import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
import { getGridOrdersByDeal } from '../../src/storage/gridOrderRepository.js';
import { getExitOrdersByDeal } from '../../src/storage/exitOrderRepository.js';
import { adoptExistingPosition } from '../../src/orchestrator/adoptExistingPosition.js';
import { buildConfig } from '../helpers/buildConfig.js';
import { defaultMarket as market, position } from '../helpers/fixtures.js';
import { createMockLogger } from '../helpers/mockLogger.js';
import type { ExchangeAdapter, OpenOrder } from '../../src/exchange/types.js';

function order(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: 'ex-1',
    clientOrderId: 'deal-1-tp-0',
    side: 'sell',
    price: 2020,
    amount: 0.05,
    filled: 0,
    status: 'open',
    reduceOnly: true,
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

describe('adoptExistingPosition — declining to adopt', () => {
  it('returns null and touches nothing when include_existing_position is false', async () => {
    const db = openDatabase();
    const config = buildConfig({ include_existing_position: false });
    const adapter = makeMockAdapter();

    const result = await adoptExistingPosition({
      adapter,
      db,
      config,
      now: () => 1000,
      dealId: 'deal-1',
    });

    expect(result).toBeNull();
    expect(adapter.fetchPosition).not.toHaveBeenCalled();
  });

  it('returns null when the flag is true but the exchange is flat', async () => {
    const db = openDatabase();
    const config = buildConfig({ include_existing_position: true });
    const adapter = makeMockAdapter({
      fetchPosition: vi.fn().mockResolvedValue(position({ contracts: 0 })),
    });

    const result = await adoptExistingPosition({
      adapter,
      db,
      config,
      now: () => 1000,
      dealId: 'deal-1',
    });

    expect(result).toBeNull();
    expect(getDeal(db, 'deal-1')).toBeNull();
  });
});

describe('adoptExistingPosition — minimal adoption (MVP §9: TP/SL only, no reconstructed grid)', () => {
  it('seeds a synthetic filled rung at the real avgEntry, places TP from it, and drives the deal to a close', async () => {
    const db = openDatabase();
    const config = buildConfig({
      include_existing_position: true,
      take_profit_pct: 1,
      stop_loss: null,
    });

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(
        position({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }),
      )
      .mockResolvedValueOnce(
        position({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }),
      )
      .mockResolvedValue(position({ contracts: 0, entryPrice: null }));

    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([order({ price: 2000 * 1.01, amount: 0.05 })])
      .mockResolvedValue([]); // TP filled -> closes

    const adapter = makeMockAdapter({ fetchPosition, fetchOpenOrders });
    let t = 1000;

    const result = await adoptExistingPosition({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(adapter.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOrderId: 'deal-1-tp-0',
        price: 2000 * 1.01,
        amount: 0.05,
        reduceOnly: true,
      }),
    );
    // Never sent to the exchange — purely the reconciliation accounting baseline.
    expect(adapter.createOrder).not.toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: 'deal-1-adopted' }),
    );

    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('SETTLING');
    expect(deal?.closeReason).toBe('tp');
    expect(deal?.pEntry).toBeCloseTo(2000, 9);

    const gridOrders = getGridOrdersByDeal(db, 'deal-1');
    expect(gridOrders).toHaveLength(1);
    expect(gridOrders[0]).toMatchObject({ status: 'filled', fillPrice: 2000, size: 0.05 });

    const exitOrders = getExitOrdersByDeal(db, 'deal-1');
    expect(exitOrders[0]).toMatchObject({ clientOrderId: 'deal-1-tp-0', status: 'filled' });
  });

  it('also places SL when config.stop_loss is set', async () => {
    const db = openDatabase();
    const config = buildConfig({
      include_existing_position: true,
      take_profit_pct: 1,
      stop_loss: 5,
    });

    // Drive it to a close via a TP fill on the tick right after adoption —
    // simplest way to observe both exit orders were created without needing
    // a separate "stop after N ticks" mechanism.
    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([
        order({ clientOrderId: 'deal-1-tp-0', price: 2000 * 1.01, amount: 0.05 }),
        order({ clientOrderId: 'deal-1-sl-0', price: 2000 * 0.95, amount: 0.05 }),
      ])
      .mockResolvedValue([
        order({ clientOrderId: 'deal-1-sl-0', price: 2000 * 0.95, amount: 0.05 }),
      ]);
    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(
        position({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }),
      )
      .mockResolvedValueOnce(
        position({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }),
      )
      .mockResolvedValue(position({ contracts: 0, entryPrice: null }));

    const adapter = makeMockAdapter({ fetchPosition, fetchOpenOrders });
    let t = 1000;

    const result = await adoptExistingPosition({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      options: { pollIntervalMs: 1 },
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(adapter.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        clientOrderId: 'deal-1-sl-0',
        price: 2000 * 0.95,
        reduceOnly: true,
      }),
    );
  });
});

describe('adoptExistingPosition — Sprint 3 Task H: dealId child-logger binding', () => {
  it('binds dealId exactly once — this is the third of runDealLoop\'s three upstream entry points', async () => {
    const db = openDatabase();
    const config = buildConfig({
      include_existing_position: true,
      take_profit_pct: 1,
      stop_loss: null,
    });

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(position({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }))
      .mockResolvedValueOnce(position({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }))
      .mockResolvedValue(position({ contracts: 0, entryPrice: null }));
    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([order({ price: 2000 * 1.01, amount: 0.05 })])
      .mockResolvedValue([]);

    const adapter = makeMockAdapter({ fetchPosition, fetchOpenOrders });
    const { logger, spies, childSpy } = createMockLogger();
    let t = 1000;

    const result = await adoptExistingPosition({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      options: { pollIntervalMs: 1 },
      logger,
    });

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(childSpy).toHaveBeenCalledTimes(1);
    expect(childSpy).toHaveBeenCalledWith({ dealId: 'deal-1' });
    expect(spies.info).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: 'deal-1', closeReason: 'tp' }),
      'deal closed',
    );
  });
});
