import type { Candle, Timeframe } from '../candles/index.js';
import type { Config } from '../config/index.js';
import type { EntrySignal, SignalEngineState, WarmupSelfCheckEntry } from '../feed/index.js';
import type { FilterSignal } from '../filters/index.js';
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

export type ExampleExchangeEvent =
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
  /** Sprint 3 Task C: latched per-filter state after this bar, config.entry_filters order — needed to count each of the 7 channels individually, not just the AND (entrySignal). */
  filterStates: readonly (FilterSignal | null)[];
  /** Latched per-filter last-computed indicator value after this bar, same order. */
  filterValues: readonly (number | null)[];
}

export interface ReplayResult {
  bars: ReplayBarResult[];
  finalState: SignalEngineState;
  warmupSelfCheck: readonly WarmupSelfCheckEntry[];
}

/** Sprint 3 Task C: one of the golden vector's 7 channels — counted on this filter's OWN native-timeframe cadence, not on every 1m latch-bar. */
export interface FilterChannelCount {
  indicator: string;
  timeframe: Timeframe;
  period: number;
  op: '<' | '>';
  value: number;
  /** Bars of this filter's own timeframe where the latch was active. */
  activeBars: number;
  /** Bars of this filter's own timeframe present in the window — the denominator. */
  totalBars: number;
}

export interface FilterVector {
  /** 1:1 with config.entry_filters, same order — no reordering. */
  channels: readonly FilterChannelCount[];
  /** 1m-cadence: bars where entrySignal !== null. */
  andBars: number;
  /** 1m-cadence: bars.length — the AND channel's own denominator. */
  totalBars: number;
}

export interface GoldenVectorChannelDiff {
  label: string;
  goldenFraction: number;
  actualFraction: number;
  /** (actualFraction - goldenFraction) * 100 — ABSOLUTE percentage points, not relative percent (see goldenVectorCheck.ts's diffChannel comment for why relative percent misleads for a low-baseline channel like AND). */
  diffPercentagePoints: number;
  withinTolerance: boolean;
}

export interface GoldenVectorDiffReport {
  /** 7, golden-vector order. */
  channels: readonly GoldenVectorChannelDiff[];
  /** The 8th golden value, called out separately from the 7 filter channels. */
  and: GoldenVectorChannelDiff;
  allWithinTolerance: boolean;
}

export interface MultiplicityCheck {
  label: string;
  finerActiveBars: number;
  coarserActiveBars: number;
  ratio: number;
  expected: number;
  toleranceFraction: number;
  withinTolerance: boolean;
}

/** Sprint 3 Task C, AC #4 (per-bar spot-check): one row per DISTINCT native-timeframe bar of the chosen filter — the same cadence a human eyeballing ExampleExchange' own chart at that timeframe would see. */
export interface FilterDumpRow {
  /** FilterSignal.since — closeTime of the bar of the filter's OWN timeframe that produced this state. */
  sinceCloseTime: number;
  value: number | null;
  active: boolean;
}

/**
 * Sprint 3 Task D: one real Survivor deal that is safe to compare bitbot's
 * own entry timing against. A deal is excluded from this list (no
 * DealSegment emitted) when its immediately-preceding deal has no known
 * real close timestamp (a runaway-cancelled deal — ExampleExchange sends no
 * notification for that cancellation, so the search window's start
 * boundary would be unknowable). Exclusion from emission is independent of
 * whether the deal's OWN close timestamp is known — an excluded deal's own
 * real close, if any, still becomes the segmentStartMs for whichever deal
 * comes after it.
 */
export interface DealSegment {
  dealId: string;
  realOpenMs: number;
  /** Inclusive: previous deal's real close, or the replay window's own start for the first deal. */
  segmentStartMs: number;
  /** Exclusive: next real dealOpened timestamp, or the replay window's own end for the last deal. */
  segmentEndMs: number;
}

/** Sprint 3 Task D: per-deal comparison of bitbot's own entry-signal bar against the real Survivor deal-open bar. */
export interface DealTimingResult {
  dealId: string;
  realOpenMs: number;
  /** closeTime of the 1m bar that triggered the real deal-open (nearest preceding candle close). */
  realBarCloseMs: number;
  /** closeTime of the first bar within the segment where bitbot's own entrySignal fired, or null if it never fired in the segment. */
  bitbotBarCloseMs: number | null;
  /** (bitbotBarCloseMs - realBarCloseMs) / 60_000, or null iff bitbotBarCloseMs is null. */
  offsetBars: number | null;
  withinTolerance: boolean;
}

export interface DealTimingReport {
  /** One per DealSegment, same order. */
  deals: readonly DealTimingResult[];
  matchedCount: number;
  totalCount: number;
}
