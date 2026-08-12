import { sleep } from '../util/time.js';
import { createSignalEngine, ingestOneMinuteCandle } from './signalEngine.js';
import type { ExchangeAdapter } from '../exchange/types.js';
import type { Config } from '../config/types.js';
import type { EntrySignal } from './types.js';

export interface WatchForEntryParams {
  adapter: ExchangeAdapter;
  config: Config;
  /** How much 1m history to backfill before going live (MVP §13.1 warm-up). */
  warmupCandles?: number;
  pollIntervalMs?: number;
  /** Injectable clock, defaults to Date.now — see the still-forming-bar guard below. */
  now?: () => number;
}

/**
 * MVP §5 (WAITING_SIGNAL) + §13.1: backfills warm-up history into the
 * signal engine (without acting on it — a signal computed from stale
 * historical data shouldn't retroactively open a deal), then polls for new
 * 1m candles and feeds each one in until entry fires. Primary channel is
 * polling here (MVP §13.5's websocket primary / poll fallback split is
 * Slice 11 — not built yet).
 *
 * Binance's fetchOHLCV always returns the currently-forming bar as its last
 * element (a resting, not-yet-closed candle). Ingesting it would compute
 * RSI/CCI on a mid-bar close and could fire entry on a value that changes by
 * the time the bar actually closes — exactly what bar_close semantics exist
 * to prevent. So any candle whose closeTime is still in the future is
 * skipped (not fed in, not marked as seen) and picked up again, now closed,
 * on a later poll. Slice 11's websocket kline stream carries this natively
 * (the `k.x` "bar closed" flag); this guard covers the poll-only fallback.
 */
export async function watchForEntry(params: WatchForEntryParams): Promise<EntrySignal> {
  const { adapter, config } = params;
  const warmupCandles = params.warmupCandles ?? 200;
  const pollIntervalMs = params.pollIntervalMs ?? 60_000;
  const now = params.now ?? Date.now;

  let state = createSignalEngine(config);
  let lastOpenTime: number | undefined;

  const history = await adapter.fetchOHLCV(config.symbol, '1m', undefined, warmupCandles);
  for (const candle of history) {
    if (candle.closeTime > now()) continue; // still-forming bar, not closed yet
    state = ingestOneMinuteCandle(config, state, candle).state;
    lastOpenTime = candle.openTime;
  }

  for (;;) {
    const candles = await adapter.fetchOHLCV(config.symbol, '1m', undefined, 5);
    for (const candle of candles) {
      if (lastOpenTime !== undefined && candle.openTime <= lastOpenTime) continue;
      if (candle.closeTime > now()) continue; // still-forming bar, wait for a later poll
      const result = ingestOneMinuteCandle(config, state, candle);
      state = result.state;
      lastOpenTime = candle.openTime;
      if (result.entrySignal) return result.entrySignal;
    }
    await sleep(pollIntervalMs);
  }
}
