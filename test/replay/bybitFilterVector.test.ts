import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { computeFilterVector } from '../../src/replay/filterVector.js';
import { compareToGoldenVector } from '../../src/replay/goldenVectorCheck.js';
import { replayWindow } from '../../src/replay/replayWindow.js';
import { loadCandles } from '../../src/replay/candleCsvLoader.js';
import { computeRsiSeries } from '../../src/indicators/index.js';
import { buildConfig } from '../helpers/buildConfig.js';
import { SURVIVOR_FILTERS } from '../helpers/survivorFilters.js';

const CSV_DIR = join(import.meta.dirname, '../fixtures/bybit-data/csv');
// Same calendar window as test/replay/filterVector.test.ts (Binance) — the
// cross-exchange sanity check is only valid if both sides look at the same
// period (Sprint 4 Task C §2 cross-feed discipline).
const WINDOW_FROM = Date.UTC(2026, 6, 23, 0, 0, 0);
const WINDOW_TO = Date.UTC(2026, 7, 22, 0, 0, 0);
const ONE_HOUR_MS = 60 * 60_000;

// Same golden vector as test/replay/filterVector.test.ts's GOLDEN_VECTOR
// (Binance, identical window) — duplicated here rather than imported, to
// avoid touching that file at all (Slice C6 discipline: the Binance path
// stays untouched). If that file's vector is ever recaptured, update both.
const BINANCE_GOLDEN_VECTOR = [21164, 4083, 620, 454, 5990, 2032, 497, 7744];

// Sanity, not fidelity (docs/SPRINT_4.md Task C AC): 15 percentage points,
// not Sprint 3's strict 2pp for the SAME-exchange Binance check — wide
// enough to absorb a legitimate Binance/Bybit price-series difference,
// tight enough to still catch a grossly broken adapter (wrong timeframe,
// corrupted kline parsing, a 10x unit error). A separate constant, not a
// mutation of Sprint 3's GOLDEN_TOLERANCE_PP.
const SANITY_TOLERANCE_PP = 15;

describe('RSI(1h) warm-up convergence — Sprint 4 Task C, Slice C6 (same operationalization as the Task D warm-up-blocker AC)', () => {
  it('|ΔRSI| between a 100h and a 200h pre-roll is < 0.5 at the validation window boundary — non-null is not enough, this proves convergence', () => {
    const oneHourCandles = loadCandles(
      { dir: CSV_DIR, symbol: 'ETHUSDT', timeframe: '1h' },
      WINDOW_FROM - 200 * ONE_HOUR_MS,
      WINDOW_FROM,
    );
    expect(oneHourCandles).toHaveLength(200);

    const closes200 = oneHourCandles.map((c) => c.close);
    const closes100 = closes200.slice(100); // the LAST 100 of the same 200 real closes — same real endpoint, shorter Wilder warm-up

    const rsiWith200hPreRoll = computeRsiSeries(closes200, 14).at(-1);
    const rsiWith100hPreRoll = computeRsiSeries(closes100, 14).at(-1);
    if (rsiWith200hPreRoll == null || rsiWith100hPreRoll == null) {
      throw new Error('expected both RSI series to be converged (non-null) at their last index');
    }

    console.log(
      `[Slice C6 convergence] RSI(1h) at window boundary — 100h pre-roll: ${String(rsiWith100hPreRoll)}, 200h pre-roll: ${String(rsiWith200hPreRoll)}, |Δ|: ${String(Math.abs(rsiWith200hPreRoll - rsiWith100hPreRoll))}`,
    );
    expect(Math.abs(rsiWith200hPreRoll - rsiWith100hPreRoll)).toBeLessThan(0.5);
  });
});

describe('Bybit filter-vector sanity vs Binance-LONG golden vector — Sprint 4 Task C, Slice C6 (±15pp sanity, NOT fidelity)', () => {
  it('replays the identical window on real Bybit klines and stays within the sanity band on all 7 channels + AND', () => {
    const config = buildConfig({ exchange: 'bybit-futures', entry_filters: SURVIVOR_FILTERS });

    const result = replayWindow({
      config,
      csvDir: CSV_DIR,
      symbol: 'ETHUSDT',
      fromMs: WINDOW_FROM,
      toMs: WINDOW_TO,
    });

    expect(result.bars).toHaveLength(30 * 24 * 60); // exactly 43200, same denominator as the Binance golden vector

    const vector = computeFilterVector(SURVIVOR_FILTERS, result.bars);
    const report = compareToGoldenVector(vector, BINANCE_GOLDEN_VECTOR, SANITY_TOLERANCE_PP);

    console.log(
      '[Slice C6] Bybit vector (activeBars/totalBars per channel):',
      vector.channels.map((c) => `${c.indicator} ${c.timeframe}: ${String(c.activeBars)}/${String(c.totalBars)}`),
      `AND: ${String(vector.andBars)}/${String(vector.totalBars)}`,
    );
    console.log('[Slice C6] diff report vs Binance golden vector:', JSON.stringify(report, null, 2));

    // AC-style localization: any offender shows up by name, not just one
    // aggregate boolean (same discipline as the Binance golden-vector test).
    const offenders = report.channels.filter((c) => !c.withinTolerance);
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    // AND is the most sensitive channel (composite of all 7 filters) —
    // a grossly broken adapter would show up here hardest; do not skip it.
    expect(report.and.withinTolerance, JSON.stringify(report.and, null, 2)).toBe(true);
    expect(report.allWithinTolerance).toBe(true);
  }, 180_000);
});
