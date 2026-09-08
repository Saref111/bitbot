import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTelegramEvents } from '../../src/replay/telegramParser.js';
import { buildDealSegments } from '../../src/replay/dealSegments.js';
import { replayWindow } from '../../src/replay/replayWindow.js';
import { compareDealTiming } from '../../src/replay/dealTiming.js';
import { buildConfig } from '../helpers/buildConfig.js';
import { SURVIVOR_FILTERS } from '../helpers/survivorFilters.js';

const FIXTURES_DIR = join(import.meta.dirname, '../fixtures');
const BINANCE_CSV_DIR = join(FIXTURES_DIR, 'binance-data/csv');

// Covers all 49 real dealOpened events (2026-07-07T02:30:02Z through
// 2026-08-19T03:00:01Z) plus warm-up margin before the first, and enough
// room after the last for its own segment to have a real search window.
const WINDOW_START_MS = Date.UTC(2026, 6, 7, 0, 0, 0);
const WINDOW_END_MS = Date.UTC(2026, 7, 20, 0, 0, 0);

describe('compareDealTiming — Sprint 3 Task D, real fixture data (AC #1/#2/#3)', () => {
  it('segments the real 49-deal timeline into exactly 36 validatable deals', () => {
    const html = readFileSync(join(FIXTURES_DIR, 'telegram-data/messages-long.html'), 'utf-8');
    const { events, errors } = parseTelegramEvents(html);
    expect(errors).toEqual([]);

    const segments = buildDealSegments(events, WINDOW_START_MS, WINDOW_END_MS);

    // Independently derived twice by hand against the real Telegram export
    // (49 total deals, 14 runaway-cancelled with no close notification, 13
    // of those exclude exactly the one deal following them — the 14th
    // runaway is the very last deal in the window and excludes nothing):
    // 49 - 13 = 36.
    expect(segments).toHaveLength(36);
  });

  it(
    'replays the real ~44-day window and reports bitbot entry-timing vs real Survivor deal-open per deal',
    () => {
      const html = readFileSync(join(FIXTURES_DIR, 'telegram-data/messages-long.html'), 'utf-8');
      const { events, errors } = parseTelegramEvents(html);
      expect(errors).toEqual([]);

      const segments = buildDealSegments(events, WINDOW_START_MS, WINDOW_END_MS);
      expect(segments).toHaveLength(36);

      const config = buildConfig({ entry_filters: SURVIVOR_FILTERS });
      const result = replayWindow({
        config,
        csvDir: BINANCE_CSV_DIR,
        symbol: 'ETHUSDT',
        fromMs: WINDOW_START_MS,
        toMs: WINDOW_END_MS,
      });

      const report = compareDealTiming(result.bars, segments);

      // Well-formedness (AC #3's "розходження явно вказує на шар" needs a
      // real per-deal dealId in the report — this is the Task H tie-in).
      expect(report.totalCount).toBe(36);
      expect(report.deals).toHaveLength(36);
      for (const [i, deal] of report.deals.entries()) {
        expect(deal.dealId).toBe(segments[i]?.dealId);
        expect(result.bars.some((b) => b.candle.closeTime === deal.realBarCloseMs)).toBe(true);
      }

      // AC #1 ("на M угодах місяця вхід bitbot у межах ±1 бар від
      // deal-open ExampleExchange"), measured empirically against this run rather
      // than presumed: all 36 validatable deals matched, every single one
      // with offsetBars===0 (exact bar coincidence, not just within
      // tolerance) — bitbot's filter+deal-machine layer reproduces real
      // Survivor entry timing exactly on this fixture. This is deterministic
      // replay over fixed historical CSVs, so a future regression here is a
      // real behavioral change, not noise — not softened with slack.
      expect(report.matchedCount).toBe(36);
      expect(report.deals.every((d) => d.offsetBars === 0)).toBe(true);
    },
    330_000,
  );
});
