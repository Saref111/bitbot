import { sleep, waitForAbort } from '../util/index.js';
import { ingestOneMinuteCandle, seedSignalEngine } from './signalEngine.js';
import { buildWarmupSelfCheck } from './warmupSelfCheck.js';
import { createNoopLogger } from '../logging/index.js';
import { DEFAULT_WARMUP_CLOSED_BARS } from './constants.js';
import type { Candle, Timeframe } from '../candles/index.js';
import type { EntrySignal, WatchForEntryParams } from './types.js';

/**
 * MVP §5 (WAITING_SIGNAL) + §13.1, Sprint 3 Task A: backfills warm-up
 * history natively per tracked timeframe (config.entry_filters' timeframes,
 * always plus 1m — see docs/SPRINT 3.md Task A) into the signal engine
 * (without acting on it — a signal computed from stale historical data
 * shouldn't retroactively open a deal, see seedSignalEngine), then polls
 * for new 1m candles and feeds each one in until entry fires. Primary
 * channel is polling here (MVP §13.5's websocket primary / poll fallback
 * split for the candle feed itself is not built yet — only order fills use
 * a websocket channel).
 *
 * Binance's fetchOHLCV always returns the currently-forming bar as its last
 * element (a resting, not-yet-closed candle). Ingesting it would compute
 * RSI/CCI on a mid-bar close and could fire entry on a value that changes by
 * the time the bar actually closes — exactly what bar_close semantics exist
 * to prevent. So any candle whose closeTime is still in the future is
 * skipped (not fed in, not marked as seen) and picked up again, now closed,
 * on a later poll or warm-up fetch. A websocket kline stream (the `k.x` "bar
 * closed" flag) would carry this natively; this guard covers the poll-only
 * path used here.
 *
 * Resolves `null` instead of an EntrySignal if `signal` fires before entry
 * does — graceful shutdown, not an error. Checked only between polls, never
 * mid-fetchOHLCV, same discipline as runDealLoop's shutdown check.
 */
export async function watchForEntry(params: WatchForEntryParams): Promise<EntrySignal | null> {
  const { adapter, config, signal } = params;
  const closedBars =
    params.warmupClosedBars ?? config.warmup?.closed_bars ?? DEFAULT_WARMUP_CLOSED_BARS;
  const pollIntervalMs = params.pollIntervalMs ?? 60_000;
  const now = params.now ?? Date.now;
  const logger = params.logger ?? createNoopLogger();

  const trackedTimeframes = new Set<Timeframe>(config.entry_filters.map((f) => f.timeframe));
  trackedTimeframes.add('1m');

  // Native per-TF fetch, NOT 1m pagination (Task A). Binance's fetchOHLCV
  // always returns the still-forming bar last, so requesting closedBars+1
  // and dropping it (same closeTime>now() guard as the live loop) leaves
  // exactly closedBars closed bars on a normal cold start.
  const perTimeframeClosedCandles: Partial<Record<Timeframe, Candle[]>> = {};
  for (const timeframe of trackedTimeframes) {
    const history = await adapter.fetchOHLCV(config.symbol, timeframe, undefined, closedBars + 1);
    const closed = history.filter((candle) => candle.closeTime <= now());
    if (closed.length < closedBars) {
      logger.warn(
        { timeframe, requested: closedBars, received: closed.length },
        'warm-up fetch-gap: fewer closed bars than requested',
      );
    }
    perTimeframeClosedCandles[timeframe] = closed;
  }

  let state = seedSignalEngine(config, perTimeframeClosedCandles, logger);

  const selfCheck = buildWarmupSelfCheck(config.entry_filters, state.candlesByTimeframe, state.filterValues);
  for (const entry of selfCheck) {
    const value = entry.value === null ? 'null' : String(entry.value);
    logger.info(
      entry,
      `warm-up self-check: ${entry.indicator}(${entry.timeframe})=${value}, bars=${String(entry.bars)}, converged=${String(entry.converged)}`,
    );
  }

  for (; ;) {
    if (signal?.aborted) return null;

    const candles = await adapter.fetchOHLCV(config.symbol, '1m', undefined, 5);
    for (const candle of candles) {
      if (candle.closeTime > now()) continue; // still-forming bar, wait for a later poll
      const result = ingestOneMinuteCandle(config, state, candle, logger);
      state = result.state;
      if (result.entrySignal) return result.entrySignal;
    }

    const waitArms: Promise<void>[] = [sleep(pollIntervalMs)];
    if (signal) waitArms.push(waitForAbort(signal));
    await Promise.race(waitArms);
  }
}
