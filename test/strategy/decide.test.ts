import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decide } from '../../src/strategy/decide.js';
import { buildConfig } from '../helpers/buildConfig.js';

describe('decide — rung_filled', () => {
  it('the first fill (filledRungsCount=1) is "open"', () => {
    const config = buildConfig({ take_profit_pct: 0.9, stop_loss: null });
    const intent = decide({ config, filledRungsCount: 1, avgEntry: 1901.54, event: 'rung_filled' });
    expect(intent.type).toBe('open');
  });

  it('the second fill (filledRungsCount=2) is "safety" — the 1↔2 boundary', () => {
    const config = buildConfig();
    const intent = decide({ config, filledRungsCount: 2, avgEntry: 1880, event: 'rung_filled' });
    expect(intent.type).toBe('safety');
  });

  it('the last rung (filledRungsCount=orders) is still "safety", no special case', () => {
    const config = buildConfig({ grid: { orders: 4 } });
    const intent = decide({ config, filledRungsCount: 4, avgEntry: 1850, event: 'rung_filled' });
    expect(intent.type).toBe('safety');
  });

  it('computes takeProfitPrice = avgEntry * (1 + take_profit_pct/100)', () => {
    const config = buildConfig({ take_profit_pct: 0.9 });
    const intent = decide({ config, filledRungsCount: 1, avgEntry: 1858.03, event: 'rung_filled' });
    if (intent.type === 'open' || intent.type === 'safety') {
      expect(intent.takeProfitPrice).toBeCloseTo(1858.03 * 1.009, 9);
    } else {
      throw new Error('expected open or safety intent');
    }
  });

  it('stopLossPrice is null when stop_loss is not configured', () => {
    const config = buildConfig({ stop_loss: null });
    const intent = decide({ config, filledRungsCount: 1, avgEntry: 1900, event: 'rung_filled' });
    if (intent.type === 'open' || intent.type === 'safety') {
      expect(intent.stopLossPrice).toBeNull();
    } else {
      throw new Error('expected open or safety intent');
    }
  });

  it('computes stopLossPrice = avgEntry * (1 - stop_loss/100) when configured', () => {
    const config = buildConfig({ stop_loss: 5 });
    const intent = decide({ config, filledRungsCount: 1, avgEntry: 1900, event: 'rung_filled' });
    if (intent.type === 'open' || intent.type === 'safety') {
      expect(intent.stopLossPrice).toBeCloseTo(1900 * 0.95, 9);
    } else {
      throw new Error('expected open or safety intent');
    }
  });
});

describe('decide — tp_filled / sl_filled', () => {
  it('tp_filled closes with reason take_profit, regardless of filledRungsCount', () => {
    const config = buildConfig();
    const intent = decide({ config, filledRungsCount: 3, avgEntry: 1900, event: 'tp_filled' });
    expect(intent).toEqual({ type: 'close', reason: 'take_profit' });
  });

  it('sl_filled closes with reason stop_loss when stop_loss is configured', () => {
    const config = buildConfig({ stop_loss: 5 });
    const intent = decide({ config, filledRungsCount: 3, avgEntry: 1900, event: 'sl_filled' });
    expect(intent).toEqual({ type: 'close', reason: 'stop_loss' });
  });

  it('throws on sl_filled when stop_loss is not configured (inconsistent event)', () => {
    const config = buildConfig({ stop_loss: null });
    expect(() =>
      decide({ config, filledRungsCount: 3, avgEntry: 1900, event: 'sl_filled' }),
    ).toThrow(/stop_loss/);
  });
});

describe('decide — guards', () => {
  it('rejects short direction as not implemented (same policy as projectGrid)', () => {
    const config = buildConfig({ direction: 'short' });
    expect(() =>
      decide({ config, filledRungsCount: 1, avgEntry: 1900, event: 'rung_filled' }),
    ).toThrow(/short/i);
  });

  it('rejects filledRungsCount = 0 (decide() assumes a fill already happened)', () => {
    const config = buildConfig();
    expect(() =>
      decide({ config, filledRungsCount: 0, avgEntry: 1900, event: 'rung_filled' }),
    ).toThrow();
  });

  it('rejects filledRungsCount > grid.orders ("не виходити за N ордерів")', () => {
    const config = buildConfig({ grid: { orders: 4 } });
    expect(() =>
      decide({ config, filledRungsCount: 5, avgEntry: 1900, event: 'rung_filled' }),
    ).toThrow();
  });

  it('rejects a non-positive avgEntry', () => {
    const config = buildConfig();
    expect(() =>
      decide({ config, filledRungsCount: 1, avgEntry: 0, event: 'rung_filled' }),
    ).toThrow();
  });
});

const gridParamsArb = fc
  .record({
    orders: fc.integer({ min: 2, max: 30 }),
  })
  .map(({ orders }) => ({ orders }));

const configArb = fc
  .record({
    grid: gridParamsArb,
    take_profit_pct: fc.double({ min: 0.01, max: 20, noNaN: true }),
    stop_loss: fc.option(fc.double({ min: 0.01, max: 50, noNaN: true }), { nil: null }),
  })
  .map((overrides) => buildConfig(overrides));

const avgEntryArb = fc.double({ min: 0.01, max: 100_000, noNaN: true });

describe('decide — property invariants (MVP §6, PLAN.md Slice 3)', () => {
  it('takeProfitPrice always equals avgEntry * (1 + take_profit_pct/100)', () => {
    fc.assert(
      fc.property(configArb, avgEntryArb, (config, avgEntry) => {
        const filledRungsCount = 1;
        const intent = decide({ config, filledRungsCount, avgEntry, event: 'rung_filled' });
        if (intent.type !== 'open' && intent.type !== 'safety') {
          throw new Error('expected open or safety intent');
        }
        const expected = avgEntry * (1 + config.take_profit_pct / 100);
        const relativeError = Math.abs(intent.takeProfitPrice - expected) / expected;
        expect(relativeError).toBeLessThan(1e-9);
      }),
    );
  });

  it('is "open" iff filledRungsCount === 1, "safety" for every other valid count', () => {
    fc.assert(
      fc.property(
        configArb,
        avgEntryArb,
        fc.integer({ min: 1, max: 30 }),
        (config, avgEntry, filledRungsCount) => {
          fc.pre(filledRungsCount <= config.grid.orders);
          const intent = decide({ config, filledRungsCount, avgEntry, event: 'rung_filled' });
          expect(intent.type).toBe(filledRungsCount === 1 ? 'open' : 'safety');
        },
      ),
    );
  });

  it('throws whenever filledRungsCount exceeds grid.orders (fill count never exceeds N)', () => {
    fc.assert(
      fc.property(
        configArb,
        avgEntryArb,
        fc.integer({ min: 1, max: 60 }),
        (config, avgEntry, extra) => {
          const filledRungsCount = config.grid.orders + extra;
          expect(() =>
            decide({ config, filledRungsCount, avgEntry, event: 'rung_filled' }),
          ).toThrow();
        },
      ),
    );
  });
});
