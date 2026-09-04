import { z } from 'zod';
import { supportedTimeframes } from '../candles/index.js';
import { logLevels } from '../logging/index.js';

export const entryFilterSchema = z.object({
  // Intentionally free-form: more indicators are meant to be added later (MVP §3).
  indicator: z.string().min(1),
  timeframe: z.enum(supportedTimeframes),
  period: z.number().int().positive(),
  op: z.enum(['<', '>']),
  value: z.number(),
});

// Sprint 3 Task A: closed bars fetched natively per tracked timeframe before
// going live — same count for every timeframe (Wilder decay is per-bar, not
// per-calendar-time). Optional and consumed with a named default at the call
// site (liveFeed.ts), not a zod .default() — test/helpers/buildConfig.ts
// builds Config as a plain literal, bypassing zod parsing, so a schema-level
// default would never reach those fixtures.
export const warmupConfigSchema = z.object({
  closed_bars: z.number().int().positive(),
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
    // Sprint 4 Task A: widened from z.enum(['long']) to the full
    // 'long'|'short' union — grid/strategy/orchestrator math threads
    // config.direction directly (sideSign etc.) instead of each site
    // hardcoding LONG or taking a redundant parallel parameter.
    direction: z.enum(['long', 'short']),
    // Sprint 4 Task C, Slice C3: widened from z.literal('binance-futures')
    // to a two-value union, mirroring direction's widening in Task A —
    // buildOrchestratorContext (main.ts) branches on this directly, no
    // separate exchange parameter threaded alongside config.
    exchange: z.enum(['binance-futures', 'bybit-futures']),
    testnet: z.boolean(),

    deposit_usdt: z.number().positive(),
    leverage: z.number().int().positive(),
    margin_mode: z.enum(['cross', 'isolated']),
    reinvest_pct: z.number().min(0).max(100),

    // per_minute is a documented placeholder (MVP §2) but not implemented yet.
    filter_calc: z.literal('bar_close'),
    entry_filters: z.array(entryFilterSchema),
    warmup: warmupConfigSchema.optional(),

    grid: gridConfigSchema,

    include_existing_position: z.boolean(),

    take_profit_pct: z.number().positive(),
    profit_currency: z.string().min(1),
    trailing_take: z.null(),
    stop_loss: z.number().positive().nullable(),
    halt_after_loss: z.boolean(),

    // Operational, not strategy config — CLI --log-level and env LOG_LEVEL
    // both take priority over this when set (see resolveLogLevel).
    logging: z.object({ level: z.enum(logLevels).optional() }).optional(),
  })
  .refine(
    (config) =>
      config.grid.partial_placement === null || config.grid.partial_placement <= config.grid.orders,
    {
      message: 'grid.partial_placement must not exceed grid.orders',
      path: ['grid', 'partial_placement'],
    },
  );
