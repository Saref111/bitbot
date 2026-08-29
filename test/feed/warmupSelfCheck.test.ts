import { describe, expect, it } from 'vitest';
import { buildWarmupSelfCheck } from '../../src/feed/warmupSelfCheck.js';
import type { EntryFilter } from '../../src/config/types.js';
import type { Candle } from '../../src/candles/types.js';

function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i,
    closeTime: i + 1,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
  }));
}

describe('buildWarmupSelfCheck — Sprint 3 Task A', () => {
  it('marks a filter converged when its seeded bar count meets the analytical threshold', () => {
    const filter: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 50 };
    const entries = buildWarmupSelfCheck([filter], { '1h': candles(120) }, [42]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      indicator: 'RSI',
      timeframe: '1h',
      period: 14,
      value: 42,
      bars: 120,
    });
    expect(entries[0]?.converged).toBe(true); // 120 >= requiredConvergenceBars('RSI', 14, 0.001)
  });

  it('marks not converged when the seeded bar count falls short, even though the value is non-null', () => {
    const filter: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 50 };
    const entries = buildWarmupSelfCheck([filter], { '1h': candles(30) }, [42]);

    expect(entries[0]).toMatchObject({ bars: 30, value: 42 });
    expect(entries[0]?.converged).toBe(false);
  });

  it('reports bars: 0 and converged: false when the timeframe was never seeded at all', () => {
    const filter: EntryFilter = { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 50 };
    const entries = buildWarmupSelfCheck([filter], {}, [null]);

    expect(entries[0]).toMatchObject({ bars: 0, value: null, converged: false });
  });

  it('CCI converges exactly at its period — no decay tail, unlike RSI', () => {
    const filter: EntryFilter = { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 50 };
    const entries = buildWarmupSelfCheck([filter], { '5m': candles(20) }, [7]);

    expect(entries[0]).toMatchObject({ bars: 20, requiredBars: 20, converged: true });
  });

  it('returns one entry per filter, in config.entry_filters order', () => {
    const rsi: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 50 };
    const cci: EntryFilter = { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 50 };
    const entries = buildWarmupSelfCheck(
      [rsi, cci],
      { '1h': candles(120), '5m': candles(20) },
      [42, 7],
    );

    expect(entries.map((e) => e.indicator)).toEqual(['RSI', 'CCI']);
  });
});
