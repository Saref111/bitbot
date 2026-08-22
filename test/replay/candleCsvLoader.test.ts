import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  parseCandleCsvContent,
  resolveCsvFilesForRange,
  loadCandles,
} from '../../src/replay/candleCsvLoader.js';

const FIXTURES_DIR = join(import.meta.dirname, '../fixtures/binance-data/csv');
const ONE_MINUTE_MS = 60_000;

describe('parseCandleCsvContent — Sprint 3 Task B', () => {
  it('skips a header row when present', () => {
    const text = 'open_time,open,high,low,close,volume\n1000,1,2,0.5,1.5,10\n';
    const candles = parseCandleCsvContent(text, ONE_MINUTE_MS);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ openTime: 1000, open: 1, high: 2, low: 0.5, close: 1.5 });
  });

  it('treats the first line as data when there is no header', () => {
    const text = '1000,1,2,0.5,1.5,10\n2000,1.5,2.5,1,2,10\n';
    const candles = parseCandleCsvContent(text, ONE_MINUTE_MS);
    expect(candles).toHaveLength(2);
    expect(candles[0]?.openTime).toBe(1000);
  });

  it('always derives closeTime as openTime + durationMs, never from the CSV close_time column', () => {
    // Column 7 (close_time) deliberately wrong (openTime, not openTime+dur-1) — must be ignored.
    const text = 'open_time,open,high,low,close,volume,close_time\n1000,1,2,0.5,1.5,10,1000\n';
    const candles = parseCandleCsvContent(text, ONE_MINUTE_MS);
    expect(candles[0]?.closeTime).toBe(1000 + ONE_MINUTE_MS);
  });

  it('throws on a malformed line instead of silently skipping it', () => {
    const text = 'open_time,open,high,low,close\n1000,1,2,not-a-number,1.5\n';
    expect(() => parseCandleCsvContent(text, ONE_MINUTE_MS)).toThrow(/line 2/);
  });

  it('throws on a line with too few fields', () => {
    const text = 'open_time,open,high,low,close\n1000,1,2\n';
    expect(() => parseCandleCsvContent(text, ONE_MINUTE_MS)).toThrow(/fewer than 5 fields/);
  });

  it('matches the real first row of csv/1m/ETHUSDT-1m-2026-07.csv (golden)', () => {
    const candles = loadCandles(
      { dir: FIXTURES_DIR, symbol: 'ETHUSDT', timeframe: '1m' },
      Date.UTC(2026, 6, 1, 0, 0, 0),
      Date.UTC(2026, 6, 1, 0, 1, 0),
    );
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      openTime: 1782864000000,
      open: 1571.48,
      high: 1573.37,
      low: 1571.48,
      close: 1572.84,
      closeTime: 1782864000000 + ONE_MINUTE_MS,
    });
  });
});

describe('resolveCsvFilesForRange — Sprint 3 Task B', () => {
  it('prefers a daily file when one exists', () => {
    const files = resolveCsvFilesForRange(
      { dir: FIXTURES_DIR, symbol: 'ETHUSDT', timeframe: '1m' },
      Date.UTC(2026, 7, 1, 0, 0, 0),
      Date.UTC(2026, 7, 2, 0, 0, 0),
    );
    expect(files).toEqual([join(FIXTURES_DIR, '1m', 'ETHUSDT-1m-2026-08-01.csv')]);
  });

  it('falls back to the monthly file when no daily file exists', () => {
    const files = resolveCsvFilesForRange(
      { dir: FIXTURES_DIR, symbol: 'ETHUSDT', timeframe: '1m' },
      Date.UTC(2026, 6, 7, 0, 0, 0),
      Date.UTC(2026, 6, 8, 0, 0, 0),
    );
    expect(files).toEqual([join(FIXTURES_DIR, '1m', 'ETHUSDT-1m-2026-07.csv')]);
  });

  it('throws when neither a daily nor monthly file covers a requested day', () => {
    expect(() =>
      resolveCsvFilesForRange(
        { dir: FIXTURES_DIR, symbol: 'ETHUSDT', timeframe: '1m' },
        Date.UTC(2020, 0, 1, 0, 0, 0),
        Date.UTC(2020, 0, 2, 0, 0, 0),
      ),
    ).toThrow(/no daily or monthly CSV found/);
  });
});

describe('loadCandles — Sprint 3 Task B', () => {
  it('is contiguous and gap-free across the July (monthly) -> August (daily) boundary', () => {
    const candles = loadCandles(
      { dir: FIXTURES_DIR, symbol: 'ETHUSDT', timeframe: '1m' },
      Date.UTC(2026, 6, 31, 23, 58, 0),
      Date.UTC(2026, 7, 1, 0, 2, 0),
    );
    expect(candles).toHaveLength(4);
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i]?.openTime).toBe((candles[i - 1]?.openTime ?? 0) + ONE_MINUTE_MS);
    }
    // The exact boundary row confirmed by direct inspection of the fixtures.
    expect(candles.find((c) => c.openTime === 1785542340000)).toBeDefined();
    expect(candles.find((c) => c.openTime === 1785542400000)).toBeDefined();
  });

  it('does not double-count rows when a query touches only the monthly file', () => {
    const candles = loadCandles(
      { dir: FIXTURES_DIR, symbol: 'ETHUSDT', timeframe: '1m' },
      Date.UTC(2026, 6, 7, 0, 0, 0),
      Date.UTC(2026, 6, 7, 0, 5, 0),
    );
    expect(candles).toHaveLength(5);
    const openTimes = candles.map((c) => c.openTime);
    expect(new Set(openTimes).size).toBe(openTimes.length);
  });
});
