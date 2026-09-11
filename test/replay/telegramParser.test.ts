import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTelegramEvents } from '../../src/replay/telegramParser.js';

const HTML = readFileSync(
  join(import.meta.dirname, '../fixtures/telegram-data/messages-long.html'),
  'utf-8',
);

describe('parseTelegramEvents — Sprint 3 Task B, real fixture (test/fixtures/telegram-data/messages-long.html)', () => {
  it('every dealId+timestamp terminator produces exactly one event or one error — the "без тихих помилок" invariant', () => {
    const { events, errors } = parseTelegramEvents(HTML);
    // 169 confirmed independently: grep -c on the terminator pattern, and
    // separately as the sum of the 4 event-hashtag counts
    // (49 dealOpened + 35 firstOrderFilled + 50 orderFilled + 35 dealClosed).
    expect(events.length + errors.length).toBe(169);
  });

  it('parses without any errors on this real export', () => {
    const { errors } = parseTelegramEvents(HTML);
    expect(errors).toEqual([]);
  });

  it('golden: deal d1169434698 — dealOpened, firstOrderFilled, orderFilled with real confirmed values', () => {
    const { events } = parseTelegramEvents(HTML);
    const deal = events.filter((e) => e.dealId === '1169434698');

    expect(deal).toContainEqual({
      type: 'dealOpened',
      dealId: '1169434698',
      timestamp: Date.UTC(2026, 6, 7, 2, 30, 2),
    });
    expect(deal).toContainEqual({
      type: 'firstOrderFilled',
      dealId: '1169434698',
      timestamp: Date.UTC(2026, 6, 7, 2, 30, 35),
      rung: 1,
      rungTotal: 14,
    });
    expect(deal).toContainEqual({
      type: 'orderFilled',
      dealId: '1169434698',
      timestamp: Date.UTC(2026, 6, 7, 2, 30, 35),
      rung: 1,
      rungTotal: 14,
      sumBase: 0.019,
      sumBaseAsset: 'ETH',
      notionalUsdt: 33.78,
      avgPrice: 1778.05,
    });
  });

  it('golden: deal d1169434698 — dealClosed with real confirmed values, duration WITH seconds', () => {
    const { events } = parseTelegramEvents(HTML);
    const closed = events.find((e) => e.dealId === '1169434698' && e.type === 'dealClosed');

    expect(closed).toEqual({
      type: 'dealClosed',
      dealId: '1169434698',
      timestamp: Date.UTC(2026, 6, 7, 15, 28, 9),
      filledRungs: 1,
      rungTotal: 14,
      durationMs: (12 * 3600 + 58 * 60 + 4) * 1000, // "12h 58m 4s"
      profitUsdt: 0.3040002,
      feeUsdt: 0.013574,
      closeReason: 'тейк-профітом',
    });
  });

  it('golden: deal d1172666525 — dealClosed with real confirmed values, duration WITHOUT seconds', () => {
    const { events } = parseTelegramEvents(HTML);
    const closed = events.find((e) => e.dealId === '1172666525' && e.type === 'dealClosed');

    expect(closed).toEqual({
      type: 'dealClosed',
      dealId: '1172666525',
      timestamp: Date.UTC(2026, 6, 12, 1, 19, 11),
      filledRungs: 1,
      rungTotal: 14,
      durationMs: (1 * 3600 + 19 * 60) * 1000, // "1h 19m" — no seconds component
      profitUsdt: 0.3047602,
      feeUsdt: 0.0136122,
      closeReason: 'тейк-профітом',
    });
  });

  it('parses firstOrderFilled and orderFilled as two distinct events for the same rung-1 fill, never merged or deduped', () => {
    const { events } = parseTelegramEvents(HTML);
    const deal = events.filter((e) => e.dealId === '1169434698');

    const first = deal.find((e) => e.type === 'firstOrderFilled');
    const order = deal.find((e) => e.type === 'orderFilled' && e.rung === 1);

    expect(first).toBeDefined();
    expect(order).toBeDefined();
    // Confirmed real behavior: identical timestamp, but only orderFilled
    // carries Сума/Номінал/Середня ціна — firstOrderFilled never does.
    expect(first?.timestamp).toBe(order?.timestamp);
  });

  it('event type counts match the real per-hashtag counts (grep-verified)', () => {
    const { events } = parseTelegramEvents(HTML);
    const counts = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts).toEqual({
      dealOpened: 49,
      firstOrderFilled: 35,
      orderFilled: 50,
      dealClosed: 35,
    });
  });

  it('reports a malformed fragment in errors, not silently, when a required field is missing', () => {
    // Has the rung counter but is deliberately missing "Сума:".
    const malformed = `
      Виконано 1 із 14 доручень.
      <a href="" onclick="return ShowHashtag(&quot;виконанийордер&quot;)">#виконанийордер</a> | <a href="">відкрити</a>
      <a href="" onclick="return ShowHashtag(&quot;d999&quot;)">#d999</a> | 2026-01-01 00:00:00
    `;
    const { events, errors } = parseTelegramEvents(malformed);
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toMatch(/Сума/);
  });
});
