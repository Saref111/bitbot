import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allFiltersActive, applyBarClose } from '../../src/filters/signals.js';
import type { FilterSignal } from '../../src/filters/types.js';
import type { EntryFilter } from '../../src/config/types.js';

const rsi1h: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 };
const cci5m: EntryFilter = { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 70 };

describe('applyBarClose — single filter', () => {
  it('sets active=true when the comparison holds', () => {
    const states = applyBarClose([rsi1h], [null], {
      timeframe: '1h',
      closeTime: 1000,
      indicatorValues: new Map([[0, 50]]),
    });
    expect(states[0]).toEqual({ active: true, since: 1000 });
  });

  it('sets active=false when the comparison does not hold', () => {
    const states = applyBarClose([rsi1h], [null], {
      timeframe: '1h',
      closeTime: 1000,
      indicatorValues: new Map([[0, 60]]),
    });
    expect(states[0]).toEqual({ active: false, since: 1000 });
  });

  it('supports the ">" operator', () => {
    const filter: EntryFilter = { ...rsi1h, op: '>', value: 40 };
    const states = applyBarClose([filter], [null], {
      timeframe: '1h',
      closeTime: 1000,
      indicatorValues: new Map([[0, 45]]),
    });
    expect(states[0]?.active).toBe(true);
  });

  it('throws when the closing timeframe has no indicator value for a matching filter', () => {
    expect(() =>
      applyBarClose([rsi1h], [null], {
        timeframe: '1h',
        closeTime: 1000,
        indicatorValues: new Map(),
      }),
    ).toThrow(/missing indicator value/);
  });

  it('treats a null indicator value (warm-up not finished) as evaluated-but-inactive, not a throw', () => {
    const states = applyBarClose([rsi1h], [null], {
      timeframe: '1h',
      closeTime: 1000,
      indicatorValues: new Map([[0, null]]),
    });
    expect(states[0]).toEqual({ active: false, since: 1000 });
    expect(allFiltersActive(states)).toBe(false);
  });
});

describe('applyBarClose — persistence across timeframes', () => {
  it('leaves a filter on a different timeframe completely untouched', () => {
    const priorStates: (FilterSignal | null)[] = [{ active: true, since: 500 }, null];
    const states = applyBarClose([rsi1h, cci5m], priorStates, {
      timeframe: '5m',
      closeTime: 1500,
      indicatorValues: new Map([[1, 60]]),
    });
    expect(states[0]).toEqual({ active: true, since: 500 }); // untouched
    expect(states[1]).toEqual({ active: true, since: 1500 }); // updated
  });

  it('a later close on the SAME timeframe fully overwrites the earlier signal (does not linger past its own TF)', () => {
    const afterFirstClose = applyBarClose([rsi1h], [null], {
      timeframe: '1h',
      closeTime: 1000,
      indicatorValues: new Map([[0, 50]]), // active
    });
    const afterSecondClose = applyBarClose([rsi1h], afterFirstClose, {
      timeframe: '1h',
      closeTime: 2000,
      indicatorValues: new Map([[0, 60]]), // now inactive
    });
    expect(afterSecondClose[0]).toEqual({ active: false, since: 2000 });
  });
});

describe('allFiltersActive', () => {
  it('is true for an empty filter list (enter immediately, MVP §3)', () => {
    expect(allFiltersActive([])).toBe(true);
  });

  it('is true only when every filter is active', () => {
    expect(
      allFiltersActive([
        { active: true, since: 1 },
        { active: true, since: 2 },
      ]),
    ).toBe(true);
  });

  it('is false when any filter is inactive', () => {
    expect(
      allFiltersActive([
        { active: true, since: 1 },
        { active: false, since: 2 },
      ]),
    ).toBe(false);
  });

  it('is false when any filter has never been evaluated (null)', () => {
    expect(allFiltersActive([{ active: true, since: 1 }, null])).toBe(false);
  });
});

describe('scenario from the docs: 1h signal from 13:00 still active for a 5m check at 13:25 (MVP §5)', () => {
  const T_13_00 = Date.UTC(2026, 0, 1, 13, 0, 0);
  const T_13_25 = Date.UTC(2026, 0, 1, 13, 25, 0);

  it('AND gate fires when the 5m condition also holds at 13:25', () => {
    let states: (FilterSignal | null)[] = [null, null];
    states = applyBarClose([rsi1h, cci5m], states, {
      timeframe: '1h',
      closeTime: T_13_00,
      indicatorValues: new Map([[0, 50]]), // RSI 50 < 55 -> active
    });
    states = applyBarClose([rsi1h, cci5m], states, {
      timeframe: '5m',
      closeTime: T_13_25,
      indicatorValues: new Map([[1, 60]]), // CCI 60 < 70 -> active
    });

    expect(states[0]).toEqual({ active: true, since: T_13_00 }); // 1h signal persisted, untouched by the 5m close
    expect(allFiltersActive(states)).toBe(true);
  });

  it('AND gate does NOT fire when the 5m condition fails at 13:25, even though 1h is still active', () => {
    let states: (FilterSignal | null)[] = [null, null];
    states = applyBarClose([rsi1h, cci5m], states, {
      timeframe: '1h',
      closeTime: T_13_00,
      indicatorValues: new Map([[0, 50]]),
    });
    states = applyBarClose([rsi1h, cci5m], states, {
      timeframe: '5m',
      closeTime: T_13_25,
      indicatorValues: new Map([[1, 80]]), // CCI 80 >= 70 -> inactive
    });

    expect(allFiltersActive(states)).toBe(false);
  });
});

const filterArb = fc.record({
  indicator: fc.constantFrom('RSI', 'CCI'),
  timeframe: fc.constantFrom<EntryFilter['timeframe']>('1m', '5m', '15m', '30m', '1h'),
  period: fc.integer({ min: 1, max: 50 }),
  op: fc.constantFrom<EntryFilter['op']>('<', '>'),
  value: fc.double({ min: -1000, max: 1000, noNaN: true }),
});

describe('applyBarClose / allFiltersActive — property invariants', () => {
  it('a signal set at one close is fully replaced (not merged) by the next close of the same timeframe', () => {
    fc.assert(
      fc.property(
        filterArb,
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (filter, firstValue, secondValue) => {
          const first = applyBarClose([filter], [null], {
            timeframe: filter.timeframe,
            closeTime: 1,
            indicatorValues: new Map([[0, firstValue]]),
          });
          const second = applyBarClose([filter], first, {
            timeframe: filter.timeframe,
            closeTime: 2,
            indicatorValues: new Map([[0, secondValue]]),
          });
          const expectedActive =
            filter.op === '<' ? secondValue < filter.value : secondValue > filter.value;
          expect(second[0]).toEqual({ active: expectedActive, since: 2 });
        },
      ),
    );
  });

  it('entry fires iff every filter state is active (full AND, not "any")', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 0, maxLength: 10 }), (activeFlags) => {
        const states: (FilterSignal | null)[] = activeFlags.map((active) => ({ active, since: 0 }));
        expect(allFiltersActive(states)).toBe(activeFlags.every(Boolean));
      }),
    );
  });
});
