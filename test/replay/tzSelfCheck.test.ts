import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTimezoneAlignment } from '../../src/replay/tzSelfCheck.js';
import { parseTelegramEvents } from '../../src/replay/telegramParser.js';
import { loadCandles } from '../../src/replay/candleCsvLoader.js';
import type { ExampleExchangeEvent } from '../../src/replay/types.js';
import type { Candle } from '../../src/candles/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '../fixtures');
const BINANCE_CSV_DIR = join(FIXTURES_DIR, 'binance-data/csv');

function dealOpened(dealId: string, timestamp: number): Extract<ExampleExchangeEvent, { type: 'dealOpened' }> {
  return { type: 'dealOpened', dealId, timestamp };
}

function candle(openTime: number, closeTime: number): Candle {
  return { openTime, closeTime, open: 1, high: 1, low: 1, close: 1 };
}

describe('checkTimezoneAlignment — Sprint 3 Task B, real fixture data (AC #4)', () => {
  it('confirms real dealOpened events sit on the UTC grid, seconds (not hours) after real Binance candle-close boundaries', () => {
    const html = readFileSync(join(FIXTURES_DIR, 'telegram-data/messages-long.html'), 'utf-8');
    const { events, errors } = parseTelegramEvents(html);
    expect(errors).toEqual([]);
    const dealOpenedEvents = events.filter(
      (e): e is Extract<ExampleExchangeEvent, { type: 'dealOpened' }> => e.type === 'dealOpened',
    );
    expect(dealOpenedEvents.length).toBeGreaterThan(0);

    // dealOpened events span 2026-07-07 through 2026-08-19 (confirmed by
    // direct inspection) — load the full range the fixtures cover so no
    // event falls outside the loaded window (which would otherwise pair it
    // with a stale, much-earlier "nearest" candle and read as a bogus
    // multi-day offset — a loader-window bug, not a timezone one).
    const oneMinute = loadCandles(
      { dir: BINANCE_CSV_DIR, symbol: 'ETHUSDT', timeframe: '1m' },
      Date.UTC(2026, 6, 1, 0, 0, 0),
      Date.UTC(2026, 7, 21, 0, 0, 0),
    );

    const report = checkTimezoneAlignment(dealOpenedEvents, oneMinute);

    expect(report.consistentWithUtc).toBe(true);
    // All 49 real dealOpened events confirmed to land 1-14s after a real
    // close boundary (mean ~2.7s) — asserting the actual observed real
    // range here, not a guessed number, so a future regression in either
    // the parser or the loader shows up as a real assertion failure.
    expect(report.samples).toHaveLength(49);
    for (const sample of report.samples) {
      expect(sample.offsetMs).toBeGreaterThanOrEqual(1000);
      expect(sample.offsetMs).toBeLessThanOrEqual(14_000);
    }
    expect(report.offsetStatsMs.mean).toBeCloseTo(2714.29, 1);
  });
});

describe('checkTimezoneAlignment — Sprint 3 Task B, synthetic counter-example (proves it discriminates)', () => {
  it('reports NOT consistent with UTC when events are actually shifted by UTC+3', () => {
    const oneMinute = [candle(0, 60_000), candle(60_000, 120_000), candle(120_000, 180_000)];
    const THREE_HOURS_MS = 3 * 60 * 60_000;
    // A "genuine" UTC event would land ~2s after a candle close (e.g. 62s);
    // shift it by +3h the way a UTC+3-vs-UTC timestamp confusion would.
    const shiftedEvents = [dealOpened('shifted-1', 62_000 + THREE_HOURS_MS)];

    const report = checkTimezoneAlignment(shiftedEvents, oneMinute);

    expect(report.consistentWithUtc).toBe(false);
    expect(report.samples[0]?.offsetMs).toBeGreaterThan(5000);
  });

  it('reports consistent with UTC for genuinely UTC-aligned synthetic events', () => {
    const oneMinute = [candle(0, 60_000), candle(60_000, 120_000)];
    const events = [dealOpened('genuine-1', 60_000 + 2_000), dealOpened('genuine-2', 120_000 + 3_000)];

    const report = checkTimezoneAlignment(events, oneMinute);

    expect(report.consistentWithUtc).toBe(true);
    expect(report.withinToleranceCount).toBe(2);
  });
});
