import type { Config, GridConfig } from '../../src/config/types.js';

export function buildConfig(
  overrides: {
    deposit_usdt?: number;
    leverage?: number;
    direction?: Config['direction'];
    grid?: Partial<GridConfig>;
  } = {},
): Config {
  return {
    symbol: 'ETH/USDT:USDT',
    direction: overrides.direction ?? 'long',
    exchange: 'binance-futures',
    testnet: false,
    deposit_usdt: overrides.deposit_usdt ?? 200,
    leverage: overrides.leverage ?? 3,
    margin_mode: 'cross',
    reinvest_pct: 20,
    filter_calc: 'bar_close',
    entry_filters: [],
    grid: {
      overlap_pct: 35,
      orders: 14,
      martingale_pct: 3,
      indent_pct: 0.2,
      log_distribution: 1.3,
      partial_placement: 3,
      runaway_cancel_pct: 0.5,
      ...overrides.grid,
    },
    include_existing_position: false,
    take_profit_pct: 0.9,
    profit_currency: 'USDT',
    trailing_take: null,
    stop_loss: null,
    halt_after_loss: false,
  };
}
