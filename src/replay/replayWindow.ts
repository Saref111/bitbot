import { TIMEFRAME_DURATION_MS } from '../candles/index.js';
import type { Candle, Timeframe } from '../candles/index.js';
import {
  seedSignalEngine,
  ingestOneMinuteCandle,
  buildWarmupSelfCheck,
  DEFAULT_WARMUP_CLOSED_BARS,
} from '../feed/index.js';
import { projectGrid } from '../grid/index.js';
import { createNoopLogger } from '../logging/index.js';
import { loadCandles } from './candleCsvLoader.js';
import type { ReplayBarResult, ReplayResult, ReplayWindowParams } from './types.js';

/**
 * Sprint 3 Task B: mirrors watchForEntry's shape, but sources candles from
 * local CSV dumps instead of adapter.fetchOHLCV, and runs synchronously —
 * no polling/sleep, this is an offline replay, not a live feed. No
 * Date.now()/randomness anywhere: determinism (AC #1, "детермінований
 * результат") is structural here, not just tested for.
 */
export function replayWindow(params: ReplayWindowParams): ReplayResult {
  const { config, csvDir, symbol, fromMs, toMs } = params;
  const closedBars = params.warmupClosedBars ?? DEFAULT_WARMUP_CLOSED_BARS;
  const logger = params.logger ?? createNoopLogger();

  const trackedTimeframes = new Set<Timeframe>(config.entry_filters.map((f) => f.timeframe));
  trackedTimeframes.add('1m');

  const perTimeframeClosedCandles: Partial<Record<Timeframe, readonly Candle[]>> = {};
  for (const timeframe of trackedTimeframes) {
    const durationMs = TIMEFRAME_DURATION_MS[timeframe];
    perTimeframeClosedCandles[timeframe] = loadCandles(
      { dir: csvDir, symbol, timeframe },
      fromMs - closedBars * durationMs,
      fromMs,
    );
  }

  let state = seedSignalEngine(config, perTimeframeClosedCandles, logger);
  const warmupSelfCheck = buildWarmupSelfCheck(
    config.entry_filters,
    state.candlesByTimeframe,
    state.filterValues,
  );
  for (const entry of warmupSelfCheck) {
    logger.info(
      entry,
      `warm-up self-check: ${entry.indicator}(${entry.timeframe})=${entry.value === null ? 'null' : String(entry.value)}, bars=${String(entry.bars)}, converged=${String(entry.converged)}`,
    );
  }

  const replayOneMinuteCandles = loadCandles({ dir: csvDir, symbol, timeframe: '1m' }, fromMs, toMs);

  const bars: ReplayBarResult[] = [];
  for (const candle of replayOneMinuteCandles) {
    const result = ingestOneMinuteCandle(config, state, candle, logger);
    state = result.state;

    const gridPlan = result.entrySignal
      ? projectGrid(config, result.entrySignal.price, `replay-${String(candle.closeTime)}`)
      : null;

    bars.push({ candle, entrySignal: result.entrySignal, gridPlan });
  }

  return { bars, finalState: state, warmupSelfCheck };
}
