import { requireAt } from '../util/index.js';
import type {
  FilterChannelCount,
  FilterVector,
  GoldenVectorChannelDiff,
  GoldenVectorDiffReport,
  MultiplicityCheck,
} from './types.js';

function diffChannel(
  label: string,
  goldenRaw: number,
  actualBars: number,
  totalBars: number,
  tolerancePercentagePoints: number,
): GoldenVectorChannelDiff {
  // Same denominator on both sides (our own replay window's own bar
  // count for this channel's timeframe) — valid because the window is
  // deliberately built to exactly match the golden vector's own implied
  // window length (Sprint 3 Task C: 30 days).
  const goldenFraction = goldenRaw / totalBars;
  const actualFraction = actualBars / totalBars;

  // Absolute percentage-point difference, NOT relative percent-of-golden.
  // Confirmed against the real fresh golden vector (Task C review): AND's
  // golden fraction (~18%) is much smaller than most filter channels'
  // (~45-70%), so the SAME absolute shift reads as a much larger relative
  // percent purely because of AND's smaller base — e.g. a 0.70pp shift is
  // ~3.9% relative on an 18%-baseline channel but only ~1.0% relative on a
  // 69%-baseline channel, despite being the identical-sized real shift.
  // Percentage points are comparable across channels regardless of their
  // baseline size; relative percent is not.
  const diffPercentagePoints = (actualFraction - goldenFraction) * 100;

  return {
    label,
    goldenFraction,
    actualFraction,
    diffPercentagePoints,
    withinTolerance: Math.abs(diffPercentagePoints) <= tolerancePercentagePoints,
  };
}

/**
 * Sprint 3 Task C, AC #1 + #3: compares each of the golden vector's 8
 * values (7 filter channels + AND) against the actual replay, as
 * fractions of that channel's own native-timeframe bar count — not raw
 * counts (see diffChannel). Tolerance is in ABSOLUTE PERCENTAGE POINTS,
 * not relative percent (see diffChannel's comment) — a relative-percent
 * tolerance penalizes low-baseline channels like AND (~18%) far more
 * harshly than high-baseline ones (~45-70%) for the same real-world-sized
 * shift. The per-channel shape of the report is what satisfies AC #5
 * ("розбіжність локалізується до конкретного індикатора"): a failing
 * assertion can filter `report.channels` down to the offending channel
 * directly, not just see one aggregate boolean.
 */
export function compareToGoldenVector(
  vector: FilterVector,
  goldenValues: readonly number[],
  tolerancePercentagePoints: number,
): GoldenVectorDiffReport {
  if (goldenValues.length !== vector.channels.length + 1) {
    throw new Error(
      `compareToGoldenVector: golden vector has ${String(goldenValues.length)} values but the filter vector has ${String(vector.channels.length)} channels + 1 AND — a mismatched config/golden-vector pairing, not a real diff`,
    );
  }

  const channels = vector.channels.map((channel, index) =>
    diffChannel(
      `${channel.indicator} ${channel.timeframe}`,
      requireAt(goldenValues, index),
      channel.activeBars,
      channel.totalBars,
      tolerancePercentagePoints,
    ),
  );

  const and = diffChannel(
    'AND',
    requireAt(goldenValues, goldenValues.length - 1),
    vector.andBars,
    vector.totalBars,
    tolerancePercentagePoints,
  );

  return {
    channels,
    and,
    allWithinTolerance: channels.every((c) => c.withinTolerance) && and.withinTolerance,
  };
}

/**
 * Sprint 3 Task C, AC #2: channel-multiplicity check (e.g. CCI 5m/15m ≈ 3,
 * CCI 5m/1h ≈ 12) — reuses the same activeBars the golden-vector
 * comparison already produced, no new data source. Takes FilterChannelCount
 * values directly rather than indices, so it doesn't need to know exact
 * positions in the Survivor config's filter array.
 */
export function checkMultiplicity(
  finer: FilterChannelCount,
  coarser: FilterChannelCount,
  expected: number,
  toleranceFraction: number,
): MultiplicityCheck {
  const ratio = finer.activeBars / coarser.activeBars;
  const diffPct = (ratio - expected) / expected;

  return {
    label: `${finer.indicator} ${finer.timeframe}/${coarser.timeframe}`,
    finerActiveBars: finer.activeBars,
    coarserActiveBars: coarser.activeBars,
    ratio,
    expected,
    toleranceFraction,
    withinTolerance: Math.abs(diffPct) <= toleranceFraction,
  };
}
