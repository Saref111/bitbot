import type { Candle } from '../candles/index.js';
import { findNearestPrecedingCloseBar } from './barCloseMapping.js';
import type { TzSelfCheckReport, TzSelfCheckSample, ExampleExchangeEvent } from './types.js';

/**
 * Sprint 3 Task B: verifies the "Telegram body timestamps are UTC"
 * assumption independently — never trusts the HTML export's own `title`
 * delivery-time metadata (confirmed unreliable: a real export's title
 * consistently says UTC+02:00, which doesn't even match the doc's own
 * earlier UTC+3/EEST claim). Only uses each dealOpened event's already-
 * parsed body timestamp, cross-referenced against real Binance 1m
 * candle-close boundaries.
 *
 * Default tolerance [0, 20000]ms: min:0 because an event can't fire before
 * the bar that triggered it has closed. max:20000 is wider than the doc's
 * illustrative "~2-3s after" — measured against all 49 real dealOpened
 * events in the fixture export, offsets range 1-14s (mean ~2.7s; the doc's
 * figure describes the typical case, not every case, real notification
 * latency has more jitter than that). 20s keeps headroom above the
 * observed real max while staying nearly three orders of magnitude below
 * the 10,800,000ms a UTC+3 hypothesis would produce — the window still
 * cleanly discriminates UTC from UTC+3, it just isn't tuned to the doc's
 * rounded-off illustrative figure specifically.
 */
export function checkTimezoneAlignment(
  dealOpenedEvents: readonly Extract<ExampleExchangeEvent, { type: 'dealOpened' }>[],
  oneMinuteCandles: readonly Candle[],
  toleranceMs: { min: number; max: number } = { min: 0, max: 20_000 },
): TzSelfCheckReport {
  const samples: TzSelfCheckSample[] = [];
  for (const event of dealOpenedEvents) {
    const nearest = findNearestPrecedingCloseBar(oneMinuteCandles, event.timestamp);
    if (!nearest) continue; // event predates all loaded candles — not evidence either way

    samples.push({
      dealId: event.dealId,
      eventTimestampMs: event.timestamp,
      nearestCandleCloseMs: nearest.closeTime,
      offsetMs: event.timestamp - nearest.closeTime,
    });
  }

  const withinToleranceCount = samples.filter(
    (s) => s.offsetMs >= toleranceMs.min && s.offsetMs <= toleranceMs.max,
  ).length;

  const offsets = samples.map((s) => s.offsetMs);
  const offsetStatsMs =
    offsets.length === 0
      ? { min: 0, max: 0, mean: 0 }
      : {
        min: Math.min(...offsets),
        max: Math.max(...offsets),
        mean: offsets.reduce((sum, o) => sum + o, 0) / offsets.length,
      };

  return {
    samples,
    toleranceMs,
    withinToleranceCount,
    consistentWithUtc: samples.length > 0 && withinToleranceCount === samples.length,
    offsetStatsMs,
  };
}
