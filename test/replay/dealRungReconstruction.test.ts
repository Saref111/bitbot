import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconstructDealRungs } from '../../src/replay/dealRungReconstruction.js';
import { parseTelegramEvents } from '../../src/replay/telegramParser.js';
import { projectGrid } from '../../src/grid/projectGrid.js';
import { checkGridFidelity } from '../../src/grid/gridFidelityCheck.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ExampleExchangeEvent } from '../../src/replay/types.js';
import type { ObservedRung } from '../../src/grid/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '../fixtures');

function orderFilled(
  dealId: string,
  rung: number,
  rungTotal: number,
  sumBase: number,
  notionalUsdt: number,
  avgPrice: number,
): ExampleExchangeEvent {
  return {
    type: 'orderFilled',
    dealId,
    timestamp: rung * 1000,
    rung,
    rungTotal,
    sumBase,
    sumBaseAsset: 'ETH',
    notionalUsdt,
    avgPrice,
  };
}

function firstOrderFilled(dealId: string, rung: number, rungTotal: number): ExampleExchangeEvent {
  return { type: 'firstOrderFilled', dealId, timestamp: rung * 1000, rung, rungTotal };
}

describe('reconstructDealRungs — synthetic', () => {
  it('recovers own (non-cumulative) price/size/notional via consecutive cumulative differences', () => {
    const events = [
      orderFilled('d1', 1, 14, 0.01, 20, 2000),
      orderFilled('d1', 2, 14, 0.03, 58, 1933.33),
    ];

    const rungs = reconstructDealRungs(events, 'd1');

    expect(rungs).toHaveLength(2);
    expect(rungs[0]).toEqual({ index: 1, price: 2000, size: 0.01, notionalUsdt: 20 });
    expect(rungs[1]?.index).toBe(2);
    expect(rungs[1]?.price).toBeCloseTo(1900, 9);
    expect(rungs[1]?.size).toBeCloseTo(0.02, 9);
    expect(rungs[1]?.notionalUsdt).toBe(38);
  });

  it('ignores firstOrderFilled events entirely', () => {
    const events = [
      firstOrderFilled('d1', 1, 14),
      orderFilled('d1', 1, 14, 0.01, 20, 2000),
      firstOrderFilled('d1', 2, 14),
      orderFilled('d1', 2, 14, 0.03, 58, 1933.33),
    ];

    const rungs = reconstructDealRungs(events, 'd1');

    expect(rungs).toHaveLength(2);
  });

  it('filters strictly by dealId, ignoring interleaved events from other deals', () => {
    const events = [
      orderFilled('d1', 1, 14, 0.01, 20, 2000),
      orderFilled('d2', 1, 14, 0.05, 100, 2000),
      orderFilled('d1', 2, 14, 0.03, 58, 1933.33),
      orderFilled('d2', 2, 14, 0.08, 155, 1937.5),
    ];

    const rungsD1 = reconstructDealRungs(events, 'd1');
    const rungsD2 = reconstructDealRungs(events, 'd2');

    expect(rungsD1).toHaveLength(2);
    expect(rungsD1[0]).toEqual({ index: 1, price: 2000, size: 0.01, notionalUsdt: 20 });
    expect(rungsD1[1]?.price).toBeCloseTo(1900, 9);
    expect(rungsD1[1]?.size).toBeCloseTo(0.02, 9);
    expect(rungsD2[0]?.notionalUsdt).toBe(100);
  });

  it('throws on a gap in the rung sequence', () => {
    const events = [orderFilled('d1', 1, 14, 0.01, 20, 2000), orderFilled('d1', 3, 14, 0.05, 95, 1900)];

    expect(() => reconstructDealRungs(events, 'd1')).toThrow(/gap|contiguous/i);
  });

  it('throws on a duplicate rung number', () => {
    const events = [
      orderFilled('d1', 1, 14, 0.01, 20, 2000),
      orderFilled('d1', 2, 14, 0.03, 58, 1933.33),
      orderFilled('d1', 2, 14, 0.05, 95, 1900),
    ];

    expect(() => reconstructDealRungs(events, 'd1')).toThrow(/gap|contiguous|duplicate/i);
  });

  it('throws if a reconstructed rung size is zero or negative (broken invariant)', () => {
    const events = [
      orderFilled('d1', 1, 14, 0.01, 20, 2000),
      orderFilled('d1', 2, 14, 0.01, 20, 2000), // no change in cumulative sumBase -> size=0
    ];

    expect(() => reconstructDealRungs(events, 'd1')).toThrow();
  });

  it('returns an empty array when the deal has no orderFilled events', () => {
    expect(reconstructDealRungs([], 'd1')).toEqual([]);
  });
});

describe('reconstructDealRungs — real fixture, deal 1175749436 (Sprint 3 Task E)', () => {
  it('reconstructs all 4 real fills with the expected own price/size/notional', () => {
    const html = readFileSync(join(FIXTURES_DIR, 'telegram-data/messages.html'), 'utf-8');
    const { events, errors } = parseTelegramEvents(html);
    expect(errors).toEqual([]);

    const rungs = reconstructDealRungs(events, '1175749436');

    expect(rungs).toHaveLength(4);
    // Reference values, hand-derived from the real cumulative Telegram
    // fields (Сума/Номінал): rung1 34.27/0.018=1903.89; rung2
    // (70.01-34.27)/(0.037-0.018)=35.74/0.019=1881.05; rung3
    // (106.93-70.01)/(0.057-0.037)=36.92/0.020=1846.00; rung4
    // (144.84-106.93)/(0.078-0.057)=37.91/0.021=1805.24. Telegram's own
    // "Сума" is only 3 decimals, so individual rung sizes (~0.018-0.021
    // ETH) carry real quantization noise once subtracted — tolerance here
    // is deliberately generous (a percent or so), not tick-tight like the
    // screenshot path.
    expect(rungs[0]?.price).toBeCloseTo(1903.89, 1);
    expect(rungs[1]?.price).toBeCloseTo(1881.05, 0);
    expect(rungs[2]?.price).toBeCloseTo(1846.0, 0);
    expect(rungs[3]?.price).toBeCloseTo(1805.24, 0);
  });

  it('shows the martingale ratio on real fills is close to 1.03, within the noise of 3-decimal ETH rounding', () => {
    const html = readFileSync(join(FIXTURES_DIR, 'telegram-data/messages.html'), 'utf-8');
    const { events } = parseTelegramEvents(html);
    const rungs = reconstructDealRungs(events, '1175749436');

    for (let i = 1; i < rungs.length; i++) {
      const ratio = (rungs[i]?.notionalUsdt ?? NaN) / (rungs[i - 1]?.notionalUsdt ?? NaN);
      expect(ratio).toBeGreaterThan(1.0);
      expect(ratio).toBeLessThan(1.06);
    }
  });

  it('rungs 2-4 match bitbot projectGrid (anchored on rung 1\'s own reconstructed price) within a wide, measured tolerance', () => {
    // Anchor-semantics: Telegram's dealOpened carries no price at all, so
    // rung 1's own reconstructed price is the only real number available
    // to use as projectGrid's entryPrice — this makes rung 1 ALWAYS show
    // a fixed, expected indent_pct-sized "mismatch" against itself by
    // construction (bitbot's own rung 1 = entryPrice*(1-indent/100) !=
    // entryPrice). Rung 1 is therefore deliberately excluded from the
    // observed map — it's the anchor-defining rung, not an independently
    // validatable one. Only rungs 2-4 are scored.
    const html = readFileSync(join(FIXTURES_DIR, 'telegram-data/messages.html'), 'utf-8');
    const { events } = parseTelegramEvents(html);
    const rungs = reconstructDealRungs(events, '1175749436');

    const entryPrice = rungs[0]?.price ?? NaN;
    const plan = projectGrid(buildConfig(), entryPrice, '1175749436');
    const observed = new Map<number, ObservedRung>(
      rungs.slice(1).map((r) => [r.index, { price: r.price, size: r.size }]),
    );

    // Calibrated from the actual measured diff (~0.21-0.25% of entryPrice
    // across rungs 2-4) — real-fill reconstruction noise from Telegram's
    // 3-decimal ETH truncation, amplified by the cumulative-difference
    // algebra on small (~0.02 ETH) individual rung sizes. Deliberately
    // much wider than the screenshot path's tolerance (that path compares
    // exact displayed values, not values back-derived through several
    // lossy subtractions).
    const REAL_FILL_TOLERANCES = { pricePct: 1, sizeEth: 0.01, averagePct: 100 };
    const report = checkGridFidelity(plan, observed, null, REAL_FILL_TOLERANCES);

    expect(report.rungs).toHaveLength(3);
    for (const rung of report.rungs) {
      expect(rung.withinTolerance, `rung ${String(rung.index)} outside tolerance`).toBe(true);
    }
    expect(report.allWithinTolerance).toBe(true);
  });
});
