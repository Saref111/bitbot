import { join } from 'node:path';

/**
 * Sprint 4 Task D — the real June SHORT×Bybit reference bot ("FIRST TEST").
 * The bot's own config lives in test/fixtures/config/june-short-bybit.yaml
 * (loaded via loadConfigFromFile, same pattern as survivor-valid.yaml for
 * LONG) — this file holds only what a YAML config can't: fixture paths and
 * the real telegram-export window boundaries.
 */
export const JUNE_CSV_DIR = join(import.meta.dirname, '../fixtures/bybit-june-data/csv');
export const JUNE_CONFIG_PATH = join(import.meta.dirname, '../fixtures/config/june-short-bybit.yaml');
export const JUNE_TELEGRAM_HTML_PATH = join(
  import.meta.dirname,
  '../fixtures/telegram-data/messages-short.html',
);

/**
 * messages-short.html's very first event is a dealClosed (dealId
 * 1145199524) for a deal whose own dealOpened is NOT in the export — the
 * bot was already mid-deal when the export window starts. Anchoring
 * WINDOW_START_MS at that close (floored to its containing 1m bar, since
 * candles are keyed by bar close) is what makes the FIRST validatable
 * segment's search window realistic — anchoring at an arbitrary calendar
 * boundary instead re-opens a multi-hour search window and produces a
 * false multi-bar miss on the first deal (measured, not assumed: floored
 * at day-boundary this deal misses by -130 bars).
 */
export const JUNE_WINDOW_START_MS = Date.UTC(2026, 5, 6, 3, 24, 0); // minute containing 1145199524's dealClosed (2026-06-06T03:24:43Z)
export const JUNE_WINDOW_END_MS = Date.UTC(2026, 5, 8, 0, 0, 0); // 2026-06-08T00:00:00Z, exclusive — covers the fixture's last event (2026-06-07T22:15:19Z) with margin
