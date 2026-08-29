import { describe, expect, it } from 'vitest';
import { compareDealTiming } from '../../src/replay/dealTiming.js';
import type { DealSegment, ReplayBarResult } from '../../src/replay/types.js';
import type { Candle } from '../../src/candles/types.js';

const MINUTE = 60_000;

function bar(closeTime: number, entryFired: boolean): ReplayBarResult {
  const candle: Candle = { openTime: closeTime - MINUTE, closeTime, open: 1, high: 1, low: 1, close: 1 };
  return {
    candle,
    entrySignal: entryFired ? { price: 1, closeTime } : null,
    gridPlan: null,
    filterStates: [],
    filterValues: [],
  };
}

function segment(dealId: string, realOpenMs: number, segmentStartMs: number, segmentEndMs: number): DealSegment {
  return { dealId, realOpenMs, segmentStartMs, segmentEndMs };
}

describe('compareDealTiming — Sprint 3 Task D', () => {
  it('reports offsetBars 0 for an exact match on the same bar', () => {
    // Real open lands 3s after the bar closing at 5 minutes.
    const realOpenMs = 5 * MINUTE + 3000;
    const bars = [bar(3 * MINUTE, false), bar(4 * MINUTE, false), bar(5 * MINUTE, true), bar(6 * MINUTE, false)];
    const segments = [segment('d1', realOpenMs, 0, 10 * MINUTE)];

    const report = compareDealTiming(bars, segments);

    expect(report.deals[0]).toEqual({
      dealId: 'd1',
      realOpenMs,
      realBarCloseMs: 5 * MINUTE,
      bitbotBarCloseMs: 5 * MINUTE,
      offsetBars: 0,
      withinTolerance: true,
    });
    expect(report.matchedCount).toBe(1);
    expect(report.totalCount).toBe(1);
  });

  it('is within tolerance for a bitbot signal one bar early or one bar late', () => {
    const realOpenMs = 5 * MINUTE + 3000;

    const early = compareDealTiming(
      [bar(4 * MINUTE, true), bar(5 * MINUTE, false)],
      [segment('early', realOpenMs, 0, 10 * MINUTE)],
    );
    expect(early.deals[0]?.offsetBars).toBe(-1);
    expect(early.deals[0]?.withinTolerance).toBe(true);

    const late = compareDealTiming(
      [bar(5 * MINUTE, false), bar(6 * MINUTE, true)],
      [segment('late', realOpenMs, 0, 10 * MINUTE)],
    );
    expect(late.deals[0]?.offsetBars).toBe(1);
    expect(late.deals[0]?.withinTolerance).toBe(true);
  });

  it('is outside tolerance for an offset of two bars', () => {
    const realOpenMs = 5 * MINUTE + 3000;
    const bars = [bar(5 * MINUTE, false), bar(6 * MINUTE, false), bar(7 * MINUTE, true)];
    const segments = [segment('d1', realOpenMs, 0, 10 * MINUTE)];

    const report = compareDealTiming(bars, segments);

    expect(report.deals[0]?.offsetBars).toBe(2);
    expect(report.deals[0]?.withinTolerance).toBe(false);
    expect(report.matchedCount).toBe(0);
  });

  it('finds a late-firing signal anywhere in the segment and reports its real (large) offset, not "never fired"', () => {
    const realOpenMs = 5 * MINUTE + 3000;
    const bars = [
      bar(5 * MINUTE, false),
      bar(6 * MINUTE, false),
      bar(7 * MINUTE, false),
      bar(8 * MINUTE, false),
      bar(9 * MINUTE, true), // fires 4 bars late, well past realOpenMs
    ];
    const segments = [segment('d1', realOpenMs, 0, 10 * MINUTE)];

    const report = compareDealTiming(bars, segments);

    expect(report.deals[0]?.bitbotBarCloseMs).toBe(9 * MINUTE);
    expect(report.deals[0]?.offsetBars).toBe(4);
    expect(report.deals[0]?.withinTolerance).toBe(false);
  });

  it('reports null bitbotBarCloseMs/offsetBars when entrySignal never fires anywhere in the segment', () => {
    const realOpenMs = 5 * MINUTE + 3000;
    const bars = [bar(4 * MINUTE, false), bar(5 * MINUTE, false), bar(6 * MINUTE, false)];
    const segments = [segment('d1', realOpenMs, 0, 10 * MINUTE)];

    const report = compareDealTiming(bars, segments);

    expect(report.deals[0]?.bitbotBarCloseMs).toBeNull();
    expect(report.deals[0]?.offsetBars).toBeNull();
    expect(report.deals[0]?.withinTolerance).toBe(false);
    expect(report.matchedCount).toBe(0);
  });

  it('maps a real open landing a few seconds after a bar close to THAT bar, not the next one (latency tolerance)', () => {
    // Real open lands 8s into what would become the NEXT bar's duration —
    // still maps to the bar whose close already happened.
    const realOpenMs = 5 * MINUTE + 8000;
    const bars = [bar(5 * MINUTE, true)];
    const segments = [segment('d1', realOpenMs, 0, 10 * MINUTE)];

    const report = compareDealTiming(bars, segments);

    expect(report.deals[0]?.realBarCloseMs).toBe(5 * MINUTE);
    expect(report.deals[0]?.offsetBars).toBe(0);
  });

  it('only searches bars within [segmentStartMs, segmentEndMs] for entrySignal', () => {
    // An entrySignal fires OUTSIDE the segment (before segmentStartMs) —
    // must not be picked up as this deal's match.
    const realOpenMs = 5 * MINUTE + 3000;
    const bars = [bar(1 * MINUTE, true), bar(5 * MINUTE, false), bar(6 * MINUTE, false)];
    const segments = [segment('d1', realOpenMs, 2 * MINUTE, 10 * MINUTE)];

    const report = compareDealTiming(bars, segments);

    expect(report.deals[0]?.bitbotBarCloseMs).toBeNull();
  });

  it('excludes a bar exactly AT segmentStartMs (start is exclusive — belongs to the PREVIOUS deal)', () => {
    const realOpenMs = 5 * MINUTE + 3000;
    // segmentStartMs === 2 * MINUTE; the bar closing exactly there is the
    // last bar of the previous deal's own segment, not this one's.
    const bars = [bar(2 * MINUTE, true), bar(5 * MINUTE, false)];
    const segments = [segment('d1', realOpenMs, 2 * MINUTE, 10 * MINUTE)];

    const report = compareDealTiming(bars, segments);

    expect(report.deals[0]?.bitbotBarCloseMs).toBeNull();
  });

  it('includes a bar exactly AT segmentEndMs (end is inclusive — the bar that fires at the next deal\'s real open still belongs here)', () => {
    const realOpenMs = 5 * MINUTE + 3000;
    // segmentEndMs === 10 * MINUTE; a signal firing exactly on that bar is
    // still within this deal's search window per the design rationale in
    // dealTiming.ts (that bar is the one that would fire AT the next real
    // deal-open, and belongs to the deal still being searched for, not the
    // next one).
    const bars = [bar(5 * MINUTE, false), bar(9 * MINUTE, false), bar(10 * MINUTE, true)];
    const segments = [segment('d1', realOpenMs, 2 * MINUTE, 10 * MINUTE)];

    const report = compareDealTiming(bars, segments);

    expect(report.deals[0]?.bitbotBarCloseMs).toBe(10 * MINUTE);
  });
});
