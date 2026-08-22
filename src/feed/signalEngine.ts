import { aggregateCandles } from '../candles/index.js';
import { requireAt } from '../util/index.js';
import type { Candle, Timeframe } from '../candles/index.js';
import { TIMEFRAME_DURATION_MS } from '../candles/index.js';
import type { Config, EntryFilter } from '../config/index.js';
import type { EntrySignal, IndicatorComputer, SignalEngineState } from './types.js';
import { TIMEFRAME_ORDER } from './constants.js';
import { computeCciSeries, computeRsiSeries } from '../indicators/index.js';
import { allFiltersActive, applyBarClose, buildFilterSnapshot } from '../filters/index.js';
import type { BarCloseEvent, FilterSignal } from '../filters/index.js';
import { createNoopLogger } from '../logging/index.js';
import type { Logger } from '../logging/index.js';

export function createSignalEngine(config: Config): SignalEngineState {
  return {
    candlesByTimeframe: {},
    liveOneMinuteBuffer: [],
    watermarks: {},
    filterStates: config.entry_filters.map(() => null),
    filterValues: config.entry_filters.map(() => null),
  };
}

const INDICATOR_COMPUTERS: Record<string, IndicatorComputer> = {
  RSI: (filter, candles) =>
    computeRsiSeries(
      candles.map((c) => c.close),
      filter.period,
    ).at(-1) ?? null,
  CCI: (filter, candles) => computeCciSeries(candles, filter.period).at(-1) ?? null,
};

function computeFilterValue(filter: EntryFilter, candles: readonly Candle[]): number | null {
  const computer = INDICATOR_COMPUTERS[filter.indicator];
  if (!computer) {
    throw new Error(`signalEngine: unsupported indicator '${filter.indicator}'`);
  }
  return computer(filter, candles);
}

/** Applies one closed bar's indicator values to filterStates/filterValues and logs the DEBUG snapshot — shared by seedSignalEngine and ingestOneMinuteCandle so both go through the exact same active/inactive math. */
function applyClosedBar(
  config: Config,
  filterStates: readonly (FilterSignal | null)[],
  filterValues: readonly (number | null)[],
  timeframe: Timeframe,
  closedBar: Candle,
  tfCandles: readonly Candle[],
  logger: Logger,
): {
  filterStates: (FilterSignal | null)[];
  filterValues: (number | null)[];
} {
  const indicatorValues = new Map<number, number | null>();
  config.entry_filters.forEach((filter, index) => {
    if (filter.timeframe !== timeframe) return;
    indicatorValues.set(index, computeFilterValue(filter, tfCandles));
  });

  const event: BarCloseEvent = {
    timeframe,
    closeTime: closedBar.closeTime,
    indicatorValues,
  };
  const nextFilterStates = applyBarClose(config.entry_filters, filterStates, event);
  const nextFilterValues = config.entry_filters.map((filter, index) =>
    filter.timeframe === timeframe
      ? (indicatorValues.get(index) ?? null)
      : (filterValues[index] ?? null),
  );

  logger.debug(
    buildFilterSnapshot(
      config.entry_filters,
      nextFilterStates,
      nextFilterValues,
      timeframe,
      closedBar.closeTime,
      TIMEFRAME_ORDER,
    ),
    'filter state snapshot (bar_close)',
  );

  return { filterStates: nextFilterStates, filterValues: nextFilterValues };
}

/**
 * Sprint 3 Task A: initializes engine state from already-fetched native
 * per-timeframe closed candles (the I/O — fetchOHLCV — is the caller's job,
 * this is pure). Deliberately does NOT compute or return an entrySignal —
 * mirrors the pre-Task-A warm-up loop's behavior of feeding historical bars
 * into the engine without ever checking the result's entrySignal: a signal
 * computed from stale historical data must not retroactively open a deal.
 * If all filters end up latched active from the seed alone, entry fires on
 * the first LIVE tick via ingestOneMinuteCandle instead — a deliberate
 * consequence, not a gap, since bar_close reevaluation already runs on every
 * new 1m close regardless of which filter last changed.
 */
export function seedSignalEngine(
  config: Config,
  perTimeframeClosedCandles: Partial<Record<Timeframe, readonly Candle[]>>,
  logger: Logger = createNoopLogger(),
): SignalEngineState {
  let state = createSignalEngine(config);
  const candlesByTimeframe: SignalEngineState['candlesByTimeframe'] = {};
  const watermarks: SignalEngineState['watermarks'] = {};
  let filterStates = state.filterStates;
  let filterValues = state.filterValues;

  const referencedTimeframes = new Set(config.entry_filters.map((filter) => filter.timeframe));
  const trackedNonOneMinute = [...referencedTimeframes].filter((tf) => tf !== '1m');

  for (const timeframe of TIMEFRAME_ORDER) {
    const candles = perTimeframeClosedCandles[timeframe];
    if (!candles || candles.length === 0) continue;

    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    candlesByTimeframe[timeframe] = sorted;
    const lastBar = requireAt(sorted, sorted.length - 1);
    watermarks[timeframe] = lastBar.closeTime;

    if (!referencedTimeframes.has(timeframe)) continue;

    const applied = applyClosedBar(
      config,
      filterStates,
      filterValues,
      timeframe,
      lastBar,
      sorted,
      createNoopLogger(), // seeding is silent by design — no bar_close DEBUG spam for ~120 bars per TF
    );
    filterStates = applied.filterStates;
    filterValues = applied.filterValues;
  }

  // The live 1m poll starts wherever the clock happens to be (e.g. 14:37),
  // not at a higher-timeframe bucket boundary — the FIRST post-seed bucket
  // of any non-1m tracked timeframe needs the already-elapsed portion of
  // ITS OWN still-open bucket (e.g. 14:00-14:36 for a 1h channel) before
  // aggregateCandles can ever complete it. That elapsed portion is already
  // sitting in the 1m seed; without seeding it into liveOneMinuteBuffer
  // here, that first bucket can never reach its required candlesPerGroup
  // count, so it never closes — the live feed instead "completes" the NEXT
  // bucket after it first, whose openTime is past the watermark, reported
  // as a spurious gap+resync while the true first bucket is lost forever.
  let liveOneMinuteBuffer: readonly Candle[] = [];
  const oneMinuteSeed = candlesByTimeframe['1m'] ?? [];
  const lastOneMinuteBar = oneMinuteSeed.at(-1);
  if (trackedNonOneMinute.length > 0 && lastOneMinuteBar) {
    const largestDurationMs = Math.max(
      ...trackedNonOneMinute.map((tf) => TIMEFRAME_DURATION_MS[tf]),
    );
    const bucketStart = Math.floor(lastOneMinuteBar.openTime / largestDurationMs) * largestDurationMs;
    liveOneMinuteBuffer = oneMinuteSeed.filter((candle) => candle.openTime >= bucketStart);

    // Guard: if the 1m seed doesn't reach back far enough to cover the
    // WHOLE straddling portion (e.g. a shallow warmupClosedBars override
    // for 1m, or — if a timeframe coarser than 1h is ever added — 1m depth
    // no longer exceeding it in minutes), the straddle above is partial and
    // that first bucket still can't close on time. Cheap to detect, worth
    // flagging rather than silently limping into the same bug this fixes.
    const earliestOneMinuteBar = requireAt(oneMinuteSeed, 0);
    if (earliestOneMinuteBar.openTime > bucketStart) {
      logger.warn(
        { largestTrackedTimeframeMs: largestDurationMs, oneMinuteSeedBars: oneMinuteSeed.length },
        'seedSignalEngine: 1m seed does not fully cover the current in-progress bucket of the largest tracked timeframe — its first post-seed close may be delayed',
      );
    }
  }

  state = { ...state, candlesByTimeframe, liveOneMinuteBuffer, watermarks, filterStates, filterValues };
  return state;
}

type AcceptResult = 'accept' | 'drop' | 'gap';

function acceptCandidate(
  watermark: number | undefined,
  candidate: Candle,
  timeframe: Timeframe,
  logger: Logger,
): AcceptResult {
  if (watermark === undefined || candidate.openTime === watermark) return 'accept';
  if (candidate.openTime < watermark) return 'drop';

  logger.warn(
    { timeframe, expectedOpenTime: watermark, actualOpenTime: candidate.openTime },
    'signal engine: gap in closed-bar stream, resyncing',
  );
  return 'gap';
}

/**
 * MVP §5 (WAITING_SIGNAL): folds one freshly-closed 1m candle into the
 * engine. Each tracked timeframe keeps its own growing candle array
 * (Sprint 3 Task A), recomputed batch-style on every new bar for that TF
 * (reusing computeRsiSeries/computeCciSeries as plain batch functions)
 * rather than a separate incremental/streaming version — a tracked
 * timeframe's own array is at most a few hundred bars, so this is cheap for
 * a feed that ticks once a minute.
 */
export function ingestOneMinuteCandle(
  config: Config,
  state: SignalEngineState,
  candle: Candle,
  logger: Logger = createNoopLogger(),
): { state: SignalEngineState; entrySignal: EntrySignal | null } {
  const referencedTimeframes = new Set(config.entry_filters.map((filter) => filter.timeframe));
  const trackedNonOneMinute = [...referencedTimeframes].filter((tf) => tf !== '1m');

  const oneMinuteAccept = acceptCandidate(state.watermarks['1m'], candle, '1m', logger);
  if (oneMinuteAccept === 'drop') {
    return { state, entrySignal: null };
  }

  const candlesByTimeframe = { ...state.candlesByTimeframe };
  const watermarks = { ...state.watermarks };
  candlesByTimeframe['1m'] = [...(candlesByTimeframe['1m'] ?? []), candle];
  watermarks['1m'] = candle.closeTime;

  let liveOneMinuteBuffer =
    trackedNonOneMinute.length > 0 ? [...state.liveOneMinuteBuffer, candle] : state.liveOneMinuteBuffer;

  // Newly-accepted closed bars this tick, keyed by timeframe, processed
  // below in TIMEFRAME_ORDER (MVP §5: higher timeframes before lower).
  const newlyClosed = new Map<Timeframe, Candle>();
  if (referencedTimeframes.has('1m')) {
    newlyClosed.set('1m', candle);
  }

  for (const timeframe of trackedNonOneMinute) {
    const candidates = aggregateCandles(liveOneMinuteBuffer, timeframe);
    for (const candidate of candidates) {
      const result = acceptCandidate(watermarks[timeframe], candidate, timeframe, logger);
      if (result === 'drop') continue; // already covered by the seed or a prior tick's aggregation

      candlesByTimeframe[timeframe] = [...(candlesByTimeframe[timeframe] ?? []), candidate];
      watermarks[timeframe] = candidate.closeTime;
      newlyClosed.set(timeframe, candidate);
    }
  }

  if (trackedNonOneMinute.length > 0) {
    const largestDurationMs = Math.max(
      ...trackedNonOneMinute.map((tf) => TIMEFRAME_DURATION_MS[tf]),
    );
    const bucketStart = Math.floor(candle.openTime / largestDurationMs) * largestDurationMs;
    // Prune by bucket boundary, NOT by count: anything before the start of
    // the still-open bucket of the LARGEST tracked timeframe is already
    // consumed. Trimming by a fixed count instead risks dropping candles
    // that still belong to an unfinished bucket, silently starving that
    // timeframe of new bars after warm-up.
    liveOneMinuteBuffer = liveOneMinuteBuffer.filter((c) => c.openTime >= bucketStart);
  }

  let filterStates = state.filterStates;
  let filterValues = state.filterValues;

  for (const timeframe of TIMEFRAME_ORDER) {
    const closedBar = newlyClosed.get(timeframe);
    if (!closedBar) continue;

    const tfCandles = candlesByTimeframe[timeframe] ?? [];
    const applied = applyClosedBar(config, filterStates, filterValues, timeframe, closedBar, tfCandles, logger);
    filterStates = applied.filterStates;
    filterValues = applied.filterValues;
  }

  const entrySignal = allFiltersActive(filterStates)
    ? { price: candle.close, closeTime: candle.closeTime }
    : null;

  return {
    state: { candlesByTimeframe, liveOneMinuteBuffer, watermarks, filterStates, filterValues },
    entrySignal,
  };
}
