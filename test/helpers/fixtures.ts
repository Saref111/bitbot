import { buildConfig } from './buildConfig.js';
import type { MarketInfo, Position } from '../../src/exchange/types.js';
import type { Candle } from '../../src/candles/types.js';

export const defaultMarket: MarketInfo = {
  symbol: 'ETH/USDT:USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minNotional: 5,
};

export function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'ETH/USDT:USDT',
    side: 'long',
    contracts: 0,
    entryPrice: null,
    liquidationPrice: null,
    ...overrides,
  };
}

const ONE_MINUTE_MS = 60_000;
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

export function candle(index: number, close: number): Candle {
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

// projectGrid(config, 2000, dealId) with these grid params, exchange-ready
// against `defaultMarket` above, is exactly: rung1 price=1996 size=0.15,
// rung2 price=1900 size=0.157 (verified once against the real computation;
// hand-picking these without verifying would risk a mismatch the reconcile
// budget check would flag as diverged instead of a clean fill).
export function twoRungConfig(overrides: Parameters<typeof buildConfig>[0] = {}) {
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
