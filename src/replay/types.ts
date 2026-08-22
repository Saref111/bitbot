import type { Candle, Timeframe } from '../candles/index.js';
import type { Config } from '../config/index.js';
import type { EntrySignal, SignalEngineState, WarmupSelfCheckEntry } from '../feed/index.js';
import type { GridPlan } from '../grid/index.js';
import type { Logger } from '../logging/index.js';

/** Sprint 3 Task B: where the CSV candle dumps live (test/fixtures/binance-data/csv/<tf>/...). */
export interface CsvCandleSourceOptions {
  /** Parent of per-timeframe subdirectories, e.g. .../binance-data/csv. */
  dir: string;
  /** CSV filename stem — 'ETHUSDT', distinct from config.symbol ('ETH/USDT:USDT'). */
  symbol: string;
  timeframe: Timeframe;
}

export interface AggregationMismatch {
  bucketOpenTime: number;
  field: 'open' | 'high' | 'low' | 'close' | 'closeTime';
  local: number;
  native: number;
}

export interface AggregationCheckReport {
  timeframe: Timeframe;
  comparedBuckets: number;
  mismatches: AggregationMismatch[];
  /** openTimes present in the local aggregation but absent from native (edge of the loaded native window) — not a mismatch. */
  localOnlyEdgeBuckets: number[];
  /** openTimes present in native but absent from the local aggregation (edge of the loaded 1m window) — not a mismatch. */
  nativeOnlyEdgeBuckets: number[];
}

export interface TelegramParseError {
  rawFragment: string;
  reason: string;
}

export type VelesEvent =
  | { type: 'dealOpened'; dealId: string; timestamp: number }
  | { type: 'firstOrderFilled'; dealId: string; timestamp: number; rung: number; rungTotal: number }
  | {
      type: 'orderFilled';
      dealId: string;
      timestamp: number;
      rung: number;
      rungTotal: number;
      sumBase: number;
      sumBaseAsset: string;
      notionalUsdt: number;
      avgPrice: number;
    }
  | {
      type: 'dealClosed';
      dealId: string;
      timestamp: number;
      filledRungs: number;
      rungTotal: number;
      durationMs: number;
      profitUsdt: number;
      feeUsdt: number;
      closeReason: string;
    };

export interface TzSelfCheckSample {
  dealId: string;
  eventTimestampMs: number;
  nearestCandleCloseMs: number;
  offsetMs: number;
}

export interface TzSelfCheckReport {
  samples: TzSelfCheckSample[];
  toleranceMs: { min: number; max: number };
  withinToleranceCount: number;
  consistentWithUtc: boolean;
  offsetStatsMs: { min: number; max: number; mean: number };
}

export interface ReplayWindowParams {
  config: Config;
  csvDir: string;
  /** CSV filename stem — 'ETHUSDT', distinct from config.symbol. */
  symbol: string;
  /** Replay window start, inclusive. */
  fromMs: number;
  /** Replay window end, exclusive. */
  toMs: number;
  /** Native closed bars per tracked timeframe backfilled before fromMs — default DEFAULT_WARMUP_CLOSED_BARS. */
  warmupClosedBars?: number;
  logger?: Logger;
}

export interface ReplayBarResult {
  candle: Candle;
  entrySignal: EntrySignal | null;
  gridPlan: GridPlan | null;
}

export interface ReplayResult {
  bars: ReplayBarResult[];
  finalState: SignalEngineState;
  warmupSelfCheck: readonly WarmupSelfCheckEntry[];
}
