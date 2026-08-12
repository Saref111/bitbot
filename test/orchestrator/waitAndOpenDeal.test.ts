import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
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

describe('waitAndOpenDeal — the bot enters exactly when filters align (MVP §5, PLAN.md Slice 8)', () => {
  it('does NOT open on a candle where the filter is still inactive, and opens at the correct price once it aligns', async () => {
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
        runaway_cancel_pct: 0,
      },
      take_profit_pct: 1,
      stop_loss: null,
    });

    const warmup = [candle(0, 100)];
    const stillInactive = candle(1, 105);
    const nowActive = candle(2, 90);

    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce(warmup)
      .mockResolvedValueOnce([stillInactive])
      .mockResolvedValueOnce([nowActive]);

    let openOrdersCall = 0;
    const fetchOpenOrders = vi.fn().mockImplementation((): Promise<OpenOrder[]> => {
      openOrdersCall += 1;
      const rung2: OpenOrder = {
        id: 'e2',
        clientOrderId: 'deal-1-2',
        side: 'buy',
        price: 85,
        amount: 0.6,
        filled: 0,
        status: 'open',
        reduceOnly: false,
      };
      if (openOrdersCall === 1) {
        const rung1: OpenOrder = { ...rung2, id: 'e1', clientOrderId: 'deal-1-1', price: 89.8 };
        return Promise.resolve([rung1, rung2]);
      }
      return Promise.resolve([rung2]); // rung 1 has filled
    });

    const fetchPosition = vi.fn().mockResolvedValue({
      symbol: 'ETH/USDT:USDT',
      side: 'long',
      contracts: 0.6,
      entryPrice: 89.8,
      liquidationPrice: 10,
    } satisfies Position);

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
      fillPollIntervalMs: 1,
      fillTimeoutMs: 1000,
    });

    // Grid was computed from entryPrice=90 (candle 2), never from 105 (candle 1).
    const buyOrderCalls = createOrder.mock.calls.filter(([params]) => params.side === 'buy');
    expect(buyOrderCalls).toHaveLength(2);
    for (const [params] of buyOrderCalls) {
      expect(params.price).toBeLessThanOrEqual(90);
      expect(params.price).toBeGreaterThan(80); // well above what a P_entry=105 grid would produce at this overlap
    }

    expect(result.avgEntry).toBeCloseTo(89.8, 9);
    expect(getDeal(db, 'deal-1')?.pEntry).toBeCloseTo(90, 9);
  });
});
