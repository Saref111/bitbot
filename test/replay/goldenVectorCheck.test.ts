import { describe, expect, it } from 'vitest';
import { compareToGoldenVector, checkMultiplicity } from '../../src/replay/goldenVectorCheck.js';
import { requireAt } from '../../src/util/index.js';
import type { FilterChannelCount, FilterVector } from '../../src/replay/types.js';

function channel(overrides: Partial<FilterChannelCount> = {}): FilterChannelCount {
  return {
    indicator: 'RSI',
    timeframe: '1h',
    period: 14,
    op: '<',
    value: 55,
    activeBars: 474,
    totalBars: 720,
    ...overrides,
  };
}

describe('compareToGoldenVector — Sprint 3 Task C', () => {
  it('reports withinTolerance for an exact match', () => {
    const vector: FilterVector = {
      channels: [channel()],
      andBars: 8266,
      totalBars: 43200,
    };

    const report = compareToGoldenVector(vector, [474, 8266], 2);

    expect(report.allWithinTolerance).toBe(true);
    expect(requireAt(report.channels, 0)).toMatchObject({ diffPercentagePoints: 0, withinTolerance: true });
    expect(report.and).toMatchObject({ diffPercentagePoints: 0, withinTolerance: true });
  });

  it('localizes a failing channel to its own entry, not just an aggregate boolean', () => {
    const vector: FilterVector = {
      channels: [
        channel({ indicator: 'RSI', timeframe: '1m', activeBars: 21412, totalBars: 43200 }),
        channel({ indicator: 'RSI', timeframe: '1h', activeBars: 900, totalBars: 720 }), // way off
      ],
      andBars: 8266,
      totalBars: 43200,
    };

    const report = compareToGoldenVector(vector, [21412, 474, 8266], 2);

    expect(report.allWithinTolerance).toBe(false);
    expect(requireAt(report.channels, 0).withinTolerance).toBe(true); // RSI 1m fine
    expect(requireAt(report.channels, 1).withinTolerance).toBe(false); // RSI 1h the offender
    expect(requireAt(report.channels, 1).label).toBe('RSI 1h');
  });

  it('compares fractions, not raw counts — invariant to absolute window length as long as golden and totalBars stay consistently paired', () => {
    const fullWindow: FilterVector = {
      channels: [channel({ activeBars: 474, totalBars: 720 })],
      andBars: 0,
      totalBars: 0,
    };
    const halfWindow: FilterVector = {
      channels: [channel({ activeBars: 237, totalBars: 360 })], // same fraction, half the bars
      andBars: 0,
      totalBars: 0,
    };

    // The golden raw value paired with each vector must correspond to
    // THAT vector's own totalBars (documented design assumption) — here
    // both are consistently paired, so both report the same fraction.
    const fullReport = compareToGoldenVector(fullWindow, [474, 0], 0.01);
    const halfReport = compareToGoldenVector(halfWindow, [237, 0], 0.01);

    expect(requireAt(fullReport.channels, 0).actualFraction).toBeCloseTo(
      requireAt(halfReport.channels, 0).actualFraction,
      9,
    );
    expect(requireAt(fullReport.channels, 0).withinTolerance).toBe(true);
    expect(requireAt(halfReport.channels, 0).withinTolerance).toBe(true);
  });

  it('is within tolerance for a small real-world-scale deviation, and outside it for a large one', () => {
    // golden = 474/720 = 65.83%.
    const withinBand: FilterVector = {
      channels: [channel({ activeBars: 465, totalBars: 720 })], // 64.58% -> 1.25pp low
      andBars: 8266,
      totalBars: 43200,
    };
    const outsideBand: FilterVector = {
      channels: [channel({ activeBars: 400, totalBars: 720 })], // 55.56% -> 10.28pp low
      andBars: 8266,
      totalBars: 43200,
    };

    expect(
      requireAt(compareToGoldenVector(withinBand, [474, 8266], 2).channels, 0).withinTolerance,
    ).toBe(true);
    expect(
      requireAt(compareToGoldenVector(outsideBand, [474, 8266], 2).channels, 0).withinTolerance,
    ).toBe(false);
  });

  it('throws when the golden vector length does not match channels.length + 1', () => {
    const vector: FilterVector = { channels: [channel()], andBars: 0, totalBars: 1 };
    expect(() => compareToGoldenVector(vector, [1, 2, 3], 2)).toThrow(/mismatched/);
  });
});

describe('checkMultiplicity — Sprint 3 Task C, AC #2', () => {
  it('reports withinTolerance when the ratio matches the expected multiplicity', () => {
    const finer = channel({ indicator: 'CCI', timeframe: '5m', activeBars: 6066 });
    const coarser = channel({ indicator: 'CCI', timeframe: '15m', activeBars: 2066 });

    const result = checkMultiplicity(finer, coarser, 3, 0.1);

    expect(result.ratio).toBeCloseTo(6066 / 2066, 5);
    expect(result.withinTolerance).toBe(true);
    expect(result.label).toBe('CCI 5m/15m');
  });

  it('reports the CCI 5m/1h ≈ 12 multiplicity from the real golden vector', () => {
    const finer = channel({ indicator: 'CCI', timeframe: '5m', activeBars: 6066 });
    const coarser = channel({ indicator: 'CCI', timeframe: '1h', activeBars: 517 });

    const result = checkMultiplicity(finer, coarser, 12, 0.1);

    expect(result.withinTolerance).toBe(true);
  });

  it('reports not withinTolerance when the ratio is far from expected', () => {
    const finer = channel({ activeBars: 1000 });
    const coarser = channel({ activeBars: 10 });

    const result = checkMultiplicity(finer, coarser, 3, 0.1);

    expect(result.withinTolerance).toBe(false);
  });
});
