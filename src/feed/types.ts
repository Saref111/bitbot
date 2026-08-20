import type { Candle, Timeframe } from '../candles/index.js';
import { Config, EntryFilter } from '../config/index.js';
import { ExchangeAdapter } from '../exchange/index.js';
import type { FilterSignal } from '../filters/index.js';
import type { Logger } from '../logging/index.js';

export interface SignalEngineState {
  oneMinuteCandles: readonly Candle[];
  lastBarCount: Partial<Record<Timeframe, number>>;
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
  /** How much 1m history to backfill before going live (MVP §13.1 warm-up). */
  warmupCandles?: number;
  pollIntervalMs?: number;
  /** Injectable clock, defaults to Date.now — see the still-forming-bar guard below. */
  now?: () => number;
  /** Graceful shutdown — checked between polls; watchForEntry resolves with null instead of an EntrySignal if aborted before one fires. */
  signal?: AbortSignal;
  /** DEBUG filter-state snapshots on every bar_close reevaluation — defaults to a silent logger when omitted. */
  logger?: Logger;
}

export type IndicatorComputer = (filter: EntryFilter, candles: readonly Candle[]) => number | null;
