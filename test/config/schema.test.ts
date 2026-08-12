import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';

interface TestEntryFilter {
  indicator?: string;
  timeframe: string;
  period: number;
  op: string;
  value: number;
}

interface TestGridConfig {
  overlap_pct: number;
  orders: number;
  martingale_pct: number;
  indent_pct: number;
  log_distribution: number;
  partial_placement: number | null;
  runaway_cancel_pct: number;
}

interface TestConfig {
  symbol: string;
  direction: string;
  exchange: string;
  testnet: boolean;
  deposit_usdt: number;
  leverage: number;
  margin_mode: string;
  reinvest_pct: number;
  filter_calc: string;
  entry_filters: TestEntryFilter[];
  grid: TestGridConfig;
  include_existing_position: boolean;
  take_profit_pct: number;
  profit_currency: string;
  trailing_take: string | null;
  stop_loss: number | null;
  halt_after_loss: boolean;
}

function validConfig(): TestConfig {
  return {
    symbol: 'ETH/USDT:USDT',
    direction: 'long',
    exchange: 'binance-futures',
    testnet: false,
    deposit_usdt: 200,
    leverage: 3,
    margin_mode: 'cross',
    reinvest_pct: 20,
    filter_calc: 'bar_close',
    entry_filters: [{ indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 }],
    grid: {
      overlap_pct: 35,
      orders: 14,
      martingale_pct: 3,
      indent_pct: 0.2,
      log_distribution: 1.3,
      partial_placement: 3,
      runaway_cancel_pct: 0.5,
    },
    include_existing_position: false,
    take_profit_pct: 0.9,
    profit_currency: 'USDT',
    trailing_take: null,
    stop_loss: null,
    halt_after_loss: false,
  };
}

function messages(result: ReturnType<typeof configSchema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('configSchema — valid configs', () => {
  it('accepts the full Survivor preset', () => {
    const result = configSchema.safeParse(validConfig());
    expect(result.success).toBe(true);
  });

  it('accepts an empty entry_filters list (enter immediately)', () => {
    const config = validConfig();
    config.entry_filters = [];
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('accepts null stop_loss, null trailing_take, null partial_placement', () => {
    const config = validConfig();
    config.stop_loss = null;
    config.trailing_take = null;
    config.grid.partial_placement = null;
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it.each(['cross', 'isolated'])('accepts margin_mode: %s', (margin_mode) => {
    const config = validConfig();
    config.margin_mode = margin_mode;
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it.each(['1m', '5m', '15m', '30m', '1h'])('accepts entry_filters timeframe: %s', (timeframe) => {
    const config = validConfig();
    config.entry_filters = [{ indicator: 'RSI', timeframe, period: 14, op: '<', value: 55 }];
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('accepts an arbitrary indicator string (intentionally open for future filters)', () => {
    const config = validConfig();
    config.entry_filters = [{ indicator: 'MACD', timeframe: '1h', period: 14, op: '<', value: 55 }];
    expect(configSchema.safeParse(config).success).toBe(true);
  });
});

describe('configSchema — invalid configs', () => {
  it('rejects deposit_usdt <= 0', () => {
    const config = validConfig();
    config.deposit_usdt = -1;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/deposit_usdt/);
  });

  it('rejects leverage <= 0', () => {
    const config = validConfig();
    config.leverage = 0;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/leverage/);
  });

  it('rejects non-integer leverage', () => {
    const config = validConfig();
    config.leverage = 2.5;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/leverage/);
  });

  it.each([-5, 150])('rejects reinvest_pct out of [0,100]: %d', (reinvest_pct) => {
    const config = validConfig();
    config.reinvest_pct = reinvest_pct;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/reinvest_pct/);
  });

  it('rejects grid.overlap_pct < 0', () => {
    const config = validConfig();
    config.grid.overlap_pct = -1;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/grid\.overlap_pct/);
  });

  it.each([0, 1])('rejects grid.orders below minimum of 2: %d', (orders) => {
    const config = validConfig();
    config.grid.orders = orders;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/grid\.orders/);
  });

  it('rejects non-integer grid.orders', () => {
    const config = validConfig();
    config.grid.orders = 3.5;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/grid\.orders/);
  });

  it('rejects grid.martingale_pct < 0', () => {
    const config = validConfig();
    config.grid.martingale_pct = -1;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/grid\.martingale_pct/);
  });

  it('rejects grid.indent_pct >= grid.overlap_pct', () => {
    const config = validConfig();
    config.grid.indent_pct = 35;
    config.grid.overlap_pct = 35;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/grid/);
  });

  it.each([0, -1, 15])('rejects out-of-range grid.partial_placement: %d', (partial_placement) => {
    const config = validConfig();
    config.grid.partial_placement = partial_placement;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/partial_placement/);
  });

  it('rejects empty symbol', () => {
    const config = validConfig();
    config.symbol = '';
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/symbol/);
  });

  it('rejects missing required field (direction)', () => {
    const config: Record<string, unknown> = { ...validConfig() };
    delete config.direction;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/direction/);
  });

  it('rejects invalid direction enum value', () => {
    const config = validConfig();
    config.direction = 'up';
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/direction/);
  });

  it('rejects direction: short (not implemented yet — MVP scope is long only)', () => {
    const config = validConfig();
    config.direction = 'short';
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/direction/);
  });

  it('rejects unsupported exchange', () => {
    const config = validConfig();
    config.exchange = 'bybit';
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/exchange/);
  });

  it('rejects entry_filters item missing indicator', () => {
    const config = validConfig();
    config.entry_filters = [{ timeframe: '1h', period: 14, op: '<', value: 55 }];
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/entry_filters\.0\.indicator/);
  });

  it('rejects entry_filters item with invalid op', () => {
    const config = validConfig();
    config.entry_filters = [{ indicator: 'RSI', timeframe: '1h', period: 14, op: '<=', value: 55 }];
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/entry_filters\.0\.op/);
  });

  it('rejects entry_filters item with period <= 0', () => {
    const config = validConfig();
    config.entry_filters = [{ indicator: 'RSI', timeframe: '1h', period: 0, op: '<', value: 55 }];
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/entry_filters\.0\.period/);
  });

  it('rejects an unsupported entry_filters timeframe (e.g. 4h — MVP §13.1 caps at 1h)', () => {
    const config = validConfig();
    config.entry_filters = [{ indicator: 'RSI', timeframe: '4h', period: 14, op: '<', value: 55 }];
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/entry_filters\.0\.timeframe/);
  });

  it('rejects filter_calc: per_minute (not implemented — MVP §2)', () => {
    const config = validConfig();
    config.filter_calc = 'per_minute';
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/filter_calc/);
  });

  it('rejects take_profit_pct <= 0', () => {
    const config = validConfig();
    config.take_profit_pct = 0;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/take_profit_pct/);
  });

  it('rejects stop_loss <= 0 when not null', () => {
    const config = validConfig();
    config.stop_loss = -2;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(messages(result).join('\n')).toMatch(/stop_loss/);
  });
});
