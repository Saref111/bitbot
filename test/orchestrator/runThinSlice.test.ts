import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
import { getGridOrdersByDeal } from '../../src/storage/gridOrderRepository.js';
import { getExitOrdersByDeal } from '../../src/storage/exitOrderRepository.js';
import { runThinSlice } from '../../src/orchestrator/runThinSlice.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ExchangeAdapter, MarketInfo, OpenOrder } from '../../src/exchange/types.js';

const market: MarketInfo = {
  symbol: 'ETH/USDT:USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minNotional: 5,
};

function order(clientOrderId: string, side: 'buy' | 'sell', price: number): OpenOrder {
  return {
    id: `ex-${clientOrderId}`,
    clientOrderId,
    side,
    price,
    amount: 0.03,
    filled: 0,
    status: 'open',
    reduceOnly: side === 'sell',
  };
}

describe('runThinSlice — full cycle (MVP §5: GRID_PLACED -> ACTIVE -> SETTLING)', () => {
  it('opens, detects the first fill, places TP, detects the TP fill, and settles the deal', async () => {
    const db = openDatabase();
    const config = buildConfig({
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

    // Sequence of fetchOpenOrders responses across the whole cycle:
    // 1) openDeal's fill-poll: rung 1 already gone (filled), rung 2 resting.
    // 2) closeDeal's TP-poll, first check: rung 2 + TP both resting.
    // 3) closeDeal's TP-poll, second check: TP gone (filled), rung 2 still resting.
    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([order('deal-1-2', 'buy', 1900)])
      .mockResolvedValueOnce([order('deal-1-2', 'buy', 1900), order('deal-1-tp', 'sell', 2016)])
      .mockResolvedValue([order('deal-1-2', 'buy', 1900)]);

    const fetchPosition = vi.fn().mockResolvedValue({
      symbol: 'ETH/USDT:USDT',
      side: 'long',
      contracts: 0.03,
      entryPrice: 1996.12,
      liquidationPrice: 1000,
    });

    const adapter: ExchangeAdapter = {
      setupSymbol: vi.fn().mockResolvedValue(undefined),
      getMarketInfo: vi.fn().mockResolvedValue(market),
      fetchOHLCV: vi.fn().mockResolvedValue([]),
      fetchPosition,
      createOrder: vi.fn().mockImplementation((params: { clientOrderId: string }) =>
        Promise.resolve({
          id: `ex-${params.clientOrderId}`,
          clientOrderId: params.clientOrderId,
          status: 'open',
        }),
      ),
      fetchOpenOrders,
      cancelAll: vi.fn().mockResolvedValue(undefined),
      fetchFundingRate: vi.fn(),
    };

    let t = 1000;
    const result = await runThinSlice({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      entryPrice: 2000,
      pollIntervalMs: 1,
      fillTimeoutMs: 1000,
    });

    expect(result.open.avgEntry).toBeCloseTo(1996.12, 9);
    expect(result.close.closeReason).toBe('tp');
    expect(adapter.cancelAll).toHaveBeenCalledWith('ETH/USDT:USDT');

    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('SETTLING');
    expect(deal?.closeReason).toBe('tp');

    expect(getGridOrdersByDeal(db, 'deal-1')).toHaveLength(2);
    const exitOrders = getExitOrdersByDeal(db, 'deal-1');
    expect(exitOrders).toHaveLength(1);
    expect(exitOrders[0]?.status).toBe('filled');
  });
});
