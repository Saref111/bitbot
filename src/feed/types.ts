import type { Candle, Timeframe } from '../candles/index.js';
import { Config, EntryFilter } from '../config/index.js';
import { ExchangeAdapter } from '../exchange/index.js';
import type { FilterSignal } from '../filters/index.js';
import type { Logger } from '../logging/index.js';

export interface SignalEngineState {
  /**
   * Closed, native-resolution candles per tracked timeframe (Sprint 3 Task
   * A): the native warm-up seed plus every bar appended since, live. Grows
   * by append only — never re-derived from a lower-resolution array, and
   * never truncated (Wilder's batch recompute needs the full series from a
   * stable origin, or the seeded convergence the warm-up bought is lost).
   */
  candlesByTimeframe: Partial<Record<Timeframe, readonly Candle[]>>;
  /**
   * Live 1m candles not yet folded into every tracked non-1m timeframe's
   * bucket. Pruned to the still-open bucket of the LARGEST tracked
   * timeframe on every ingest (by bucket boundary, not by count) — anything
   * older is already consumed into candlesByTimeframe. Stays empty when
   * only 1m is tracked.
   */
  liveOneMinuteBuffer: readonly Candle[];
  /**
   * closeTime of the last accepted bar per timeframe — the seed/live splice
   * seam (generalizes the old 1m-only lastOpenTime watermark to every
   * tracked timeframe). A candidate bar is accepted when its openTime
   * equals this; older is a duplicate (dropped), newer is a gap (logged,
   * then resynced).
   */
  watermarks: Partial<Record<Timeframe, number>>;
  filterStates: (FilterSignal | null)[];
  /** Latched last-closed-bar value per filter, in config.entry_filters order — DEBUG snapshot input only, doesn't affect entry logic. */
  filterValues: (number | null)[];
}

export interface EntrySignal {
  price: number;
  closeTime: number;
}

export interface WatchForEntryParams {
  adapter: ExchangeAdapter;
  config: Config;
  /**
   * Override for how many closed bars to backfill natively per tracked
   * timeframe before going live (MVP §13.1 / Sprint 3 Task A warm-up) —
   * takes precedence over config.warmup.closed_bars, which itself falls
   * back to DEFAULT_WARMUP_CLOSED_BARS. Applied uniformly to every tracked
   * timeframe (Wilder decay is per-bar, not per-calendar-time), NOT "total
   * 1m bars" as the old `warmupCandles` name meant before Task A.
   */
  warmupClosedBars?: number;
  pollIntervalMs?: number;
  /** Injectable clock, defaults to Date.now — see the still-forming-bar guard below. */
  now?: () => number;
  /** Graceful shutdown — checked between polls; watchForEntry resolves with null instead of an EntrySignal if aborted before one fires. */
  signal?: AbortSignal;
  /** DEBUG filter-state snapshots on every bar_close reevaluation — defaults to a silent logger when omitted. */
  logger?: Logger;
}

export type IndicatorComputer = (filter: EntryFilter, candles: readonly Candle[]) => number | null;
