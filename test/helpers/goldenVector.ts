/**
 * docs/SPRINT_3-done.md §2 — "Кількість сигналів за останній місяць" from
 * the real ExampleExchange UI, rolling 30 days, re-captured 2026-08-22/23
 * to match the freshest window our downloaded fixtures cover
 * (test/fixtures/binance-data only has daily dumps through 2026-08-21 —
 * today's day is never published, per script.sh's own "до вчора" logic).
 * Supersedes an earlier capture (~2026-08-19) that was compared against a
 * slightly mismatched window and produced a since-resolved false RSI(30m)
 * miss.
 *
 * SINGLE SOURCE OF TRUTH (Sprint 4 Task C, Slice C7): this value and the
 * window below used to be defined independently in filterVector.test.ts
 * (Binance, ±2pp fidelity) and duplicated in bybitFilterVector.test.ts
 * (Bybit, ±15pp sanity) with an "update both if this ever changes"
 * comment — an acknowledged drift risk, not a fix. goldenVectorCheck.test.ts
 * separately drifted out of sync with a stale hardcoded copy of two of
 * these values (CCI 5m/1h). All three now import from here instead of
 * each carrying their own copy.
 *
 * Order matches test/helpers/survivorFilters.ts's SURVIVOR_FILTERS 1:1:
 * [RSI 1m, RSI 5m, RSI 30m, RSI 1h, CCI 5m, CCI 15m, CCI 1h, AND].
 */
export const GOLDEN_VECTOR = [21164, 4083, 620, 454, 5990, 2032, 497, 7744];

/**
 * Same calendar window every consumer of GOLDEN_VECTOR must replay —
 * the vector above is only meaningful paired with the exact period it was
 * captured over. Also the window both the Binance fidelity check and the
 * Bybit sanity check replay identically (Sprint 4 Task C §2 cross-feed
 * discipline: the cross-exchange comparison is only valid if both sides
 * look at the same period).
 */
export const GOLDEN_WINDOW_FROM_MS = Date.UTC(2026, 6, 23, 0, 0, 0); // 2026-07-23T00:00:00Z
export const GOLDEN_WINDOW_TO_MS = Date.UTC(2026, 7, 22, 0, 0, 0); // 2026-08-22T00:00:00Z, exclusive

/** 30 days of 1m bars — the golden vector's own implied denominator. */
export const GOLDEN_WINDOW_BAR_COUNT = 30 * 24 * 60;
