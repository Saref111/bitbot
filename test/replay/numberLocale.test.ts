import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseLocaleNumber } from '../../src/replay/numberLocale.js';

describe('parseLocaleNumber — Sprint 3 Task B (ExampleExchange locale: comma decimal, U+00A0 thousands)', () => {
  it('parses a confirmed real value with a thousands separator', () => {
    // Real value from test/fixtures/telegram-data/messages.html (deal
    // d1169434698's orderFilled "Середня ціна"). \u00A0 confirmed via hex dump as the
    // actual separator byte, not a plain space.
    expect(parseLocaleNumber('1\u00A0778,05')).toBeCloseTo(1778.05, 9);
  });

  it('parses a confirmed real value without a thousands separator', () => {
    expect(parseLocaleNumber('33,78')).toBeCloseTo(33.78, 9);
  });

  it('parses the doc-cited example', () => {
    expect(parseLocaleNumber('1\u00A0896,2')).toBeCloseTo(1896.2, 9);
  });

  it('parses an integer with no decimal part', () => {
    expect(parseLocaleNumber('1782')).toBeCloseTo(1782, 9);
  });

  it('is defensive against a plain space too, not just U+00A0', () => {
    expect(parseLocaleNumber('1 778,05')).toBeCloseTo(1778.05, 9);
  });

  it('throws on non-numeric input rather than returning NaN silently', () => {
    expect(() => parseLocaleNumber('not-a-number')).toThrow(/not a valid locale number/);
  });

  it('round-trips values formatted with NBSP-thousands and comma-decimal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 0, max: 99 }),
        (whole, fraction) => {
          const wholeStr = whole.toLocaleString('en-US').replace(/,/g, '\u00A0');
          const formatted = `${wholeStr},${fraction.toString().padStart(2, '0')}`;
          const expected = whole + fraction / 100;
          expect(parseLocaleNumber(formatted)).toBeCloseTo(expected, 6);
        },
      ),
    );
  });
});
