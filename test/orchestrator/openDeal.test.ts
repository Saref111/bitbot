import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
import { getGridOrdersByDeal } from '../../src/storage/gridOrderRepository.js';
import { getExitOrdersByDeal } from '../../src/storage/exitOrderRepository.js';
import { openDeal } from '../../src/orchestrator/openDeal.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ExchangeAdapter, MarketInfo, OpenOrder, Position } from '../../src/exchange/types.js';

const market: MarketInfo = {
  symbol: 'ETH/USDT:USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minNotional: 5,
};

function makeMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    setupSymbol: vi.fn().mockResolvedValue(undefined),
    getMarketInfo: vi.fn().mockResolvedValue(market),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    fetchPosition: vi.fn(),
    createOrder: vi.fn().mockImplementation((params: { clientOrderId: string }) =>
      Promise.resolve({
        id: `ex-${params.clientOrderId}`,
        clientOrderId: params.clientOrderId,
        status: 'open',
      }),
    ),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    cancelAll: vi.fn().mockResolvedValue(undefined),
    fetchFundingRate: vi.fn(),
    ...overrides,
  };
}

function config() {
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
      runaway_cancel_pct: 0,
    },
    take_profit_pct: 1,
    stop_loss: null,
  });
}

describe('openDeal — happy path (MVP §5: GRID_PLACED -> ACTIVE -> TP placed)', () => {
  it('persists the grid, places all rungs, detects the first fill, and places TP from the real avg entry', async () => {
    const db = openDatabase();
    const cfg = config();
    const entryPrice = 2000;
    const dealId = 'deal-1';

    let openOrdersCall = 0;
    const fetchOpenOrders = vi.fn().mockImplementation((): Promise<OpenOrder[]> => {
      openOrdersCall += 1;
      // First poll: both rungs still resting. Second poll: rung 1 has filled (gone).
      if (openOrdersCall === 1) {
        return Promise.resolve([
          {
            id: 'e1',
            clientOrderId: 'deal-1-1',
            side: 'buy',
            price: 1996,
            amount: 0.03,
            filled: 0,
            status: 'open',
            reduceOnly: false,
          },
          {
            id: 'e2',
            clientOrderId: 'deal-1-2',
            side: 'buy',
            price: 1900,
            amount: 0.03,
            filled: 0,
            status: 'open',
            reduceOnly: false,
          },
        ]);
      }
      return Promise.resolve([
        {
          id: 'e2',
          clientOrderId: 'deal-1-2',
          side: 'buy',
          price: 1900,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: false,
        },
      ]);
    });

    const fetchPosition = vi.fn().mockResolvedValue({
      symbol: 'ETH/USDT:USDT',
      side: 'long',
      contracts: 0.03,
      entryPrice: 1996.12,
      liquidationPrice: 1000,
    } satisfies Position);

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    const result = await openDeal({
      adapter,
      db,
      config: cfg,
      now: () => t++,
      dealId,
      entryPrice,
      pollIntervalMs: 1,
      fillTimeoutMs: 1000,
    });

    expect(result.avgEntry).toBeCloseTo(1996.12, 9);
    expect(result.takeProfitPrice).toBeCloseTo(1996.12 * 1.01, 6);

    // 2 grid orders (buy) + 1 TP order (sell, reduceOnly)
    expect(adapter.createOrder).toHaveBeenCalledTimes(3);
    expect(adapter.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'sell', reduceOnly: true, clientOrderId: 'deal-1-tp' }),
    );

    const deal = getDeal(db, dealId);
    expect(deal?.status).toBe('ACTIVE');
    expect(deal?.filledRungsCount).toBe(1);
    expect(deal?.pEntry).toBeCloseTo(entryPrice, 9);

    const gridOrders = getGridOrdersByDeal(db, dealId);
    expect(gridOrders).toHaveLength(2);
    expect(gridOrders[0]?.status).toBe('filled');
    expect(gridOrders[1]?.status).toBe('placed');

    const exitOrders = getExitOrdersByDeal(db, dealId);
    expect(exitOrders).toHaveLength(1);
    expect(exitOrders[0]?.type).toBe('tp');
    expect(exitOrders[0]?.clientOrderId).toBe('deal-1-tp');
    expect(exitOrders[0]?.price).toBeCloseTo(1996.12 * 1.01, 6);
  });

  it('places a stop-loss exit order too when config.stop_loss is set', async () => {
    const db = openDatabase();
    const cfg = buildConfig({
      deposit_usdt: 200,
      leverage: 3,
      grid: {
        orders: 2,
        overlap_pct: 5,
        indent_pct: 0.2,
        martingale_pct: 0,
        log_distribution: 1,
        partial_placement: null,
        runaway_cancel_pct: 0,
      },
      take_profit_pct: 1,
      stop_loss: 5,
    });

    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'e1',
          clientOrderId: 'deal-1-1',
          side: 'buy',
          price: 1996,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: false,
        },
        {
          id: 'e2',
          clientOrderId: 'deal-1-2',
          side: 'buy',
          price: 1900,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: false,
        },
      ])
      .mockResolvedValue([
        {
          id: 'e2',
          clientOrderId: 'deal-1-2',
          side: 'buy',
          price: 1900,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: false,
        },
      ]);
    const fetchPosition = vi.fn().mockResolvedValue({
      symbol: 'ETH/USDT:USDT',
      side: 'long',
      contracts: 0.03,
      entryPrice: 2000,
      liquidationPrice: 1000,
    } satisfies Position);

    const adapter = makeMockAdapter({ fetchOpenOrders, fetchPosition });
    let t = 1000;

    await openDeal({
      adapter,
      db,
      config: cfg,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      pollIntervalMs: 1,
      fillTimeoutMs: 1000,
    });

    const exitOrders = getExitOrdersByDeal(db, 'deal-1');
    expect(exitOrders.map((o) => o.type).sort()).toEqual(['sl', 'tp']);
    const sl = exitOrders.find((o) => o.type === 'sl');
    expect(sl?.price).toBeCloseTo(2000 * 0.95, 9);
  });

  it('throws if the grid is not exchange-ready (minNotional rejection)', async () => {
    const db = openDatabase();
    const cfg = buildConfig({
      deposit_usdt: 0.01,
      leverage: 1,
      grid: { orders: 2, overlap_pct: 5, indent_pct: 0.2 },
    });
    const adapter = makeMockAdapter();

    await expect(
      openDeal({
        adapter,
        db,
        config: cfg,
        now: () => 1000,
        dealId: 'deal-1',
        entryPrice: 2000,
        pollIntervalMs: 1,
        fillTimeoutMs: 1000,
      }),
    ).rejects.toThrow(/minNotional/);
  });
});
