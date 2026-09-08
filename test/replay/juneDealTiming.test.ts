import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTelegramEvents } from '../../src/replay/telegramParser.js';
import { buildDealSegments } from '../../src/replay/dealSegments.js';
import { replayWindow } from '../../src/replay/replayWindow.js';
import { compareDealTiming } from '../../src/replay/dealTiming.js';
import { loadConfigFromFile } from '../../src/config/loadConfig.js';
import {
  JUNE_CONFIG_PATH,
  JUNE_CSV_DIR,
  JUNE_TELEGRAM_HTML_PATH,
  JUNE_WINDOW_END_MS,
  JUNE_WINDOW_START_MS,
} from '../helpers/juneShortBybit.js';

/**
 * Sprint 4 Task D — filter-match + deal-open timing ACs, real June
 * SHORT×Bybit reference ("FIRST TEST" bot, messages-short.html). Same
 * oracle as Sprint 3 Task D's Binance-LONG golden test
 * (dealTiming.golden.test.ts) — the filter layer is unchanged (SHORT
 * shares SURVIVOR_FILTERS verbatim, docs/SPRINT_4.md), so a timing miss
 * here would localize to the deal-machine/direction wiring, not the
 * filters (already validated in Sprint 3).
 */
describe('compareDealTiming — Sprint 4 Task D, real June SHORT×Bybit fixture', () => {
  it('segments the real 8-dealOpened window into 7 validatable deals (1 excluded — the runaway 1145359771 has no close, so the deal right after it, 1145365108, has an unknowable segment start)', () => {
    const html = readFileSync(JUNE_TELEGRAM_HTML_PATH, 'utf-8');
    const { events, errors } = parseTelegramEvents(html);
    expect(errors).toEqual([]);

    const segments = buildDealSegments(events, JUNE_WINDOW_START_MS, JUNE_WINDOW_END_MS);
    expect(segments).toHaveLength(7);
    expect(segments.map((s) => s.dealId)).toEqual([
      '1145260929',
      '1145301837',
      '1145311026',
      '1145348764',
      '1145359771',
      '1145439792',
      '1145694954',
    ]);
  });

  it(
    'replays the real ~43h June window and matches bitbot entry-timing to real deal-open on all 7 validatable deals, exactly (offsetBars===0)',
    () => {
      const html = readFileSync(JUNE_TELEGRAM_HTML_PATH, 'utf-8');
      const { events, errors } = parseTelegramEvents(html);
      expect(errors).toEqual([]);

      const segments = buildDealSegments(events, JUNE_WINDOW_START_MS, JUNE_WINDOW_END_MS);
      expect(segments).toHaveLength(7);

      const config = loadConfigFromFile(JUNE_CONFIG_PATH);
      const result = replayWindow({
        config,
        csvDir: JUNE_CSV_DIR,
        symbol: 'ETHUSDT',
        fromMs: JUNE_WINDOW_START_MS,
        toMs: JUNE_WINDOW_END_MS,
      });

      const report = compareDealTiming(result.bars, segments);

      expect(report.totalCount).toBe(7);
      expect(report.deals).toHaveLength(7);
      for (const [i, deal] of report.deals.entries()) {
        expect(deal.dealId).toBe(segments[i]?.dealId);
        expect(result.bars.some((b) => b.candle.closeTime === deal.realBarCloseMs)).toBe(true);
      }

      // Measured empirically against this run (not presumed): all 7
      // validatable deals matched, every one with offsetBars===0 — same
      // exact-coincidence result Sprint 3 got on the 36-deal Binance-LONG
      // set, now confirmed direction+exchange-agnostic on real SHORT×Bybit
      // data. Deterministic replay over fixed historical CSVs, so a future
      // regression here is a real behavioral change, not noise.
      expect(report.matchedCount).toBe(7);
      expect(report.deals.every((d) => d.offsetBars === 0)).toBe(true);
    },
    120_000,
  );
});
