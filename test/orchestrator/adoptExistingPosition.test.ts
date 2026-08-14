import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
import { getGridOrdersByDeal } from '../../src/storage/gridOrderRepository.js';
import { getExitOrdersByDeal } from '../../src/storage/exitOrderRepository.js';
import { adoptExistingPosition } from '../../src/orchestrator/adoptExistingPosition.js';
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

function makeMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    setupSymbol: vi.fn().mockResolvedValue(undefined),
    getMarketInfo: vi.fn().mockResolvedValue(market),
    fetchOHLCV: vi
      .fn()
      .mockResolvedValue([
        { openTime: 0, closeTime: 60_000, open: 2000, high: 2000, low: 2000, close: 2000 },
      ]),
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
      fetchPosition: vi.fn().mockResolvedValue(pos({ contracts: 0 })),
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
      .mockResolvedValueOnce(pos({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }))
      .mockResolvedValueOnce(pos({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }))
      .mockResolvedValue(pos({ contracts: 0, entryPrice: null }));

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
      .mockResolvedValueOnce(pos({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }))
      .mockResolvedValueOnce(pos({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 }))
      .mockResolvedValue(pos({ contracts: 0, entryPrice: null }));

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
