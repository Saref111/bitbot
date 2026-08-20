import { describe, expect, it } from 'vitest';
import { buildFilterSnapshot } from '../../src/filters/snapshot.js';
import type { FilterSignal } from '../../src/filters/types.js';
import type { EntryFilter } from '../../src/config/types.js';

const rsi1h: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 };
const cci5m: EntryFilter = { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 70 };
const rsi1m: EntryFilter = { indicator: 'RSI', timeframe: '1m', period: 14, op: '<', value: 50 };

// High->low, matching feed/constants.ts TIMEFRAME_ORDER.
const GATE_ORDER = ['1h', '30m', '15m', '5m', '1m'] as const;

describe('buildFilterSnapshot', () => {
  it('marks gatePassed and blockedBy:null when every filter is active', () => {
    const states: (FilterSignal | null)[] = [
      { active: true, since: 1000 },
      { active: true, since: 2000 },
    ];
    const snapshot = buildFilterSnapshot(
      [rsi1h, cci5m],
      states,
      [50, 60],
      '5m',
      2000,
      GATE_ORDER,
    );

    expect(snapshot.gatePassed).toBe(true);
    expect(snapshot.blockedBy).toBeNull();
    expect(snapshot.triggeredTf).toBe('5m');
    expect(snapshot.closeTimeMs).toBe(2000);
    expect(snapshot.closeTimeIso).toBe(new Date(2000).toISOString());
    expect(snapshot.filters).toEqual([
      { indicator: 'RSI', tf: '1h', value: 50, threshold: 55, pass: true },
      { indicator: 'CCI', tf: '5m', value: 60, threshold: 70, pass: true },
    ]);
  });

  it('reports the first failing filter in gate order (high->low TF), not declaration order', () => {
    // Declared 1m first, 1h second — but gate order must still pick the 1h failure first.
    const states: (FilterSignal | null)[] = [
      { active: false, since: 1000 }, // 1m fails
      { active: false, since: 2000 }, // 1h fails
    ];
    const snapshot = buildFilterSnapshot(
      [rsi1m, rsi1h],
      states,
      [55, 60],
      '1m',
      1000,
      GATE_ORDER,
    );

    expect(snapshot.gatePassed).toBe(false);
    expect(snapshot.blockedBy).toEqual({
      indicator: 'RSI',
      tf: '1h',
      value: 60,
      threshold: 55,
      pass: false,
    });
  });

  it('treats a warm-up filter (null value, never-evaluated state) as value:null, pass:false, without throwing', () => {
    const states: (FilterSignal | null)[] = [null, { active: true, since: 2000 }];
    const snapshot = buildFilterSnapshot(
      [rsi1h, cci5m],
      states,
      [null, 60],
      '5m',
      2000,
      GATE_ORDER,
    );

    expect(snapshot.filters[0]).toEqual({
      indicator: 'RSI',
      tf: '1h',
      value: null,
      threshold: 55,
      pass: false,
    });
    expect(snapshot.gatePassed).toBe(false);
    expect(snapshot.blockedBy?.indicator).toBe('RSI');
  });

  it('keeps filters[] in original entry_filters order regardless of gate order', () => {
    const states: (FilterSignal | null)[] = [
      { active: true, since: 1000 },
      { active: true, since: 1000 },
    ];
    const snapshot = buildFilterSnapshot(
      [rsi1m, rsi1h],
      states,
      [10, 20],
      '1m',
      1000,
      GATE_ORDER,
    );

    expect(snapshot.filters.map((f) => f.tf)).toEqual(['1m', '1h']);
  });

  it('handles an empty filter list (MVP §3: enter immediately)', () => {
    const snapshot = buildFilterSnapshot([], [], [], '1m', 1000, GATE_ORDER);
    expect(snapshot.gatePassed).toBe(true);
    expect(snapshot.blockedBy).toBeNull();
    expect(snapshot.filters).toEqual([]);
  });
});
