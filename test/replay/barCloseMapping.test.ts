import { describe, expect, it } from 'vitest';
import { findCandleByCloseTime } from '../../src/replay/barCloseMapping.js';
import type { Candle } from '../../src/candles/types.js';

function candle(openTime: number, closeTime: number): Candle {
  return { openTime, closeTime, open: 1, high: 1, low: 1, close: 1 };
}

describe('findCandleByCloseTime — Sprint 3 Task B', () => {
  it('finds the candle whose closeTime matches exactly', () => {
    const candles = [candle(0, 60_000), candle(60_000, 120_000), candle(120_000, 180_000)];
    expect(findCandleByCloseTime(candles, 120_000)).toBe(candles[1]);
  });

  it('returns undefined when no candle has that closeTime', () => {
    const candles = [candle(0, 60_000)];
    expect(findCandleByCloseTime(candles, 999_999)).toBeUndefined();
  });

  it('reproduces the doc worked example: T=02:00 UTC maps to the 1h candle with openTime=01:00 UTC', () => {
    const openTime = Date.UTC(2026, 0, 1, 1, 0, 0); // 01:00
    const closeTime = Date.UTC(2026, 0, 1, 2, 0, 0); // 02:00 = openTime + 1h
    const candles = [candle(openTime, closeTime)];

    const found = findCandleByCloseTime(candles, Date.UTC(2026, 0, 1, 2, 0, 0));

    expect(found).toBeDefined();
    expect(found?.openTime).toBe(openTime);
  });
});
