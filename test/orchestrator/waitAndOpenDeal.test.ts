import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
import { getGridOrdersByDeal } from '../../src/storage/gridOrderRepository.js';
import { waitAndOpenDeal } from '../../src/orchestrator/waitAndOpenDeal.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type {
  CreateOrderParams,
  ExchangeAdapter,
  MarketInfo,
  OpenOrder,
  Position,
} from '../../src/exchange/types.js';
import type { Candle } from '../../src/candles/types.js';
import type { EntryFilter } from '../../src/config/types.js';

const market: MarketInfo = {
  symbol: 'ETH/USDT:USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minNotional: 5,
};
const ONE_MINUTE_MS = 60_000;
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

function candle(index: number, close: number): Candle {
  const openTime = START + index * ONE_MINUTE_MS;
  return {
    openTime,
    closeTime: openTime + ONE_MINUTE_MS,
    open: close,
    high: close,
    low: close,
    close,
  };
}

function openOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: 'e1',
    clientOrderId: 'deal-1-1',
    side: 'buy',
    price: 89.82,
    amount: 3.34,
    filled: 0,
    status: 'open',
    reduceOnly: false,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'ETH/USDT:USDT',
    side: 'long',
    contracts: 0,
    entryPrice: null,
    liquidationPrice: null,
    ...overrides,
  };
}

describe('waitAndOpenDeal — the bot enters exactly when filters align (MVP §5, PLAN.md Slice 8+9)', () => {
  it('does NOT open on a candle where the filter is still inactive, opens the grid at the correct price once it aligns, and drives the deal to a close', async () => {
    // period=1 RSI depends only on the latest price change (Wilder smoothing
    // collapses to it for period=1): 100->105 gives RSI=100 (inactive,
    // NOT < 50); 105->90 gives RSI=0 (active). Entry must fire at candle 2
    // (price 90), never at candle 1 (price 105).
    const filter: EntryFilter = {
      indicator: 'RSI',
      timeframe: '1m',
      period: 1,
      op: '<',
      value: 50,
    };
    const config = buildConfig({
      entry_filters: [filter],
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
    });

    const warmup = [candle(0, 100)];
    const stillInactive = candle(1, 105);
    const nowActive = candle(2, 90);

    // projectGrid(config, 90, 'deal-1') exchange-ready against `market`:
    // rung1 price=89.82 size=3.34, rung2 price=85.5 size=3.508 (verified
    // once against the real computation, not hand-picked).
    const rung1 = openOrder({ clientOrderId: 'deal-1-1', price: 89.82, amount: 3.34 });
    const rung2 = openOrder({ clientOrderId: 'deal-1-2', side: 'buy', price: 85.5, amount: 3.508 });
    const tp = openOrder({
      clientOrderId: 'deal-1-tp-0',
      side: 'sell',
      reduceOnly: true,
      price: 89.82 * 1.01,
      amount: 3.34,
    });

    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce(warmup)
      .mockResolvedValueOnce([stillInactive])
      .mockResolvedValueOnce([nowActive])
      .mockResolvedValue([candle(3, 90)]); // runDeal's runaway-check reads, stable at P_entry -> never breaches

    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([rung1, rung2]) // GRID_PLACED tick 1: both resting
      .mockResolvedValueOnce([rung2]) // GRID_PLACED tick 2: rung1 filled
      .mockResolvedValueOnce([rung2, tp]) // ACTIVE tick 1: TP now resting too
      .mockResolvedValue([rung2]); // ACTIVE tick 2: TP filled -> closes

    const fetchPosition = vi
      .fn()
      .mockResolvedValueOnce(position({ contracts: 0 }))
      .mockResolvedValueOnce(position({ contracts: 3.34, entryPrice: 89.82, liquidationPrice: 10 }))
      .mockResolvedValueOnce(position({ contracts: 3.34, entryPrice: 89.82, liquidationPrice: 10 }))
      .mockResolvedValue(position({ contracts: 0, entryPrice: null }));

    const createOrder = vi.fn((params: CreateOrderParams) =>
      Promise.resolve({
        id: `ex-${params.clientOrderId}`,
        clientOrderId: params.clientOrderId,
        status: 'open',
      }),
    );

    const adapter: ExchangeAdapter = {
      setupSymbol: vi.fn().mockResolvedValue(undefined),
      getMarketInfo: vi.fn().mockResolvedValue(market),
      fetchOHLCV,
      fetchPosition,
      createOrder,
      fetchOpenOrders,
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      cancelAll: vi.fn().mockResolvedValue(undefined),
      fetchFundingRate: vi.fn(),
    };

    const db = openDatabase();
    // Starts at/after the last candle's closeTime so the "still-forming bar"
    // guard in watchForEntry doesn't skip these fixture candles as unclosed.
    let t = nowActive.closeTime;

    const result = await waitAndOpenDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      warmupCandles: 1,
      feedPollIntervalMs: 1,
      dealPollIntervalMs: 1,
    });

    // Grid was computed from entryPrice=90 (candle 2), never from 105 (candle 1).
    const buyOrderCalls = createOrder.mock.calls.filter(([params]) => params.side === 'buy');
    expect(buyOrderCalls).toHaveLength(2);
    for (const [params] of buyOrderCalls) {
      expect(params.price).toBeLessThanOrEqual(90);
      expect(params.price).toBeGreaterThan(80); // well above what a P_entry=105 grid would produce at this overlap
    }

    expect(result).toEqual({ outcome: 'closed', closeReason: 'tp' });
    expect(getDeal(db, 'deal-1')?.pEntry).toBeCloseTo(90, 9);
    expect(getGridOrdersByDeal(db, 'deal-1').find((o) => o.rungIndex === 1)?.fillPrice).toBeCloseTo(
      89.82,
      9,
    );
  });
});
