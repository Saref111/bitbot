import { sleep, waitForAbort } from '../util/index.js';
import { createSignalEngine, ingestOneMinuteCandle } from './signalEngine.js';
import { createNoopLogger } from '../logging/index.js';
import type { EntrySignal, WatchForEntryParams } from './types.js';

/**
 * MVP §5 (WAITING_SIGNAL) + §13.1: backfills warm-up history into the
 * signal engine (without acting on it — a signal computed from stale
 * historical data shouldn't retroactively open a deal), then polls for new
 * 1m candles and feeds each one in until entry fires. Primary channel is
 * polling here (MVP §13.5's websocket primary / poll fallback split for the
 * candle feed itself is not built yet — only order fills use a websocket
 * channel).
 *
 * Binance's fetchOHLCV always returns the currently-forming bar as its last
 * element (a resting, not-yet-closed candle). Ingesting it would compute
 * RSI/CCI on a mid-bar close and could fire entry on a value that changes by
 * the time the bar actually closes — exactly what bar_close semantics exist
 * to prevent. So any candle whose closeTime is still in the future is
 * skipped (not fed in, not marked as seen) and picked up again, now closed,
 * on a later poll. A websocket kline stream (the `k.x` "bar closed" flag)
 * would carry this natively; this guard covers the poll-only path used here.
 *
 * Resolves `null` instead of an EntrySignal if `signal` fires before entry
 * does — graceful shutdown, not an error. Checked only between polls, never
 * mid-fetchOHLCV, same discipline as runDealLoop's shutdown check.
 */
export async function watchForEntry(params: WatchForEntryParams): Promise<EntrySignal | null> {
  const { adapter, config, signal } = params;
  const warmupCandles = params.warmupCandles ?? 200;
  const pollIntervalMs = params.pollIntervalMs ?? 60_000;
  const now = params.now ?? Date.now;
  const logger = params.logger ?? createNoopLogger();

  let state = createSignalEngine(config);
  let lastOpenTime: number | undefined;

  const history = await adapter.fetchOHLCV(config.symbol, '1m', undefined, warmupCandles);
  for (const candle of history) {
    if (candle.closeTime > now()) continue; // still-forming bar, not closed yet
    state = ingestOneMinuteCandle(config, state, candle).state;
    lastOpenTime = candle.openTime;
  }

  for (; ;) {
    if (signal?.aborted) return null;

    const candles = await adapter.fetchOHLCV(config.symbol, '1m', undefined, 5);
    for (const candle of candles) {
      if (lastOpenTime !== undefined && candle.openTime <= lastOpenTime) continue;
      if (candle.closeTime > now()) continue; // still-forming bar, wait for a later poll
      const result = ingestOneMinuteCandle(config, state, candle, logger);
      state = result.state;
      lastOpenTime = candle.openTime;
      if (result.entrySignal) return result.entrySignal;
    }

    const waitArms: Promise<void>[] = [sleep(pollIntervalMs)];
    if (signal) waitArms.push(waitForAbort(signal));
    await Promise.race(waitArms);
  }
}
