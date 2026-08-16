import { z } from 'zod';
import { supportedTimeframes } from '../candles/index.js';

export const entryFilterSchema = z.object({
  // Intentionally free-form: more indicators are meant to be added later (MVP §3).
  indicator: z.string().min(1),
  timeframe: z.enum(supportedTimeframes),
  period: z.number().int().positive(),
  op: z.enum(['<', '>']),
  value: z.number(),
});

export const gridConfigSchema = z
  .object({
    overlap_pct: z.number().nonnegative(),
    orders: z.number().int().min(2),
    martingale_pct: z.number().nonnegative(),
    indent_pct: z.number().nonnegative(),
    log_distribution: z.number().positive(),
    partial_placement: z.number().int().positive().nullable(),
    runaway_cancel_pct: z.number().nonnegative(),
  })
  .refine((grid) => grid.indent_pct < grid.overlap_pct, {
    message: 'indent_pct must be less than overlap_pct',
    path: ['indent_pct'],
  });

export const configSchema = z
  .object({
    symbol: z.string().min(1),
    // 'short' is future work — narrowed here so it's rejected at config load,
    // not deep inside grid math or the strategy classifier.
    direction: z.enum(['long']),
    exchange: z.literal('binance-futures'),
    testnet: z.boolean(),

    deposit_usdt: z.number().positive(),
    leverage: z.number().int().positive(),
    margin_mode: z.enum(['cross', 'isolated']),
    reinvest_pct: z.number().min(0).max(100),

    // per_minute is a documented placeholder (MVP §2) but not implemented yet.
    filter_calc: z.literal('bar_close'),
    entry_filters: z.array(entryFilterSchema),

    grid: gridConfigSchema,

    include_existing_position: z.boolean(),

    take_profit_pct: z.number().positive(),
    profit_currency: z.string().min(1),
    trailing_take: z.null(),
    stop_loss: z.number().positive().nullable(),
    halt_after_loss: z.boolean(),
  })
  .refine(
    (config) =>
      config.grid.partial_placement === null || config.grid.partial_placement <= config.grid.orders,
    {
      message: 'grid.partial_placement must not exceed grid.orders',
      path: ['grid', 'partial_placement'],
    },
  );
