import type { DealSegment, ExampleExchangeEvent } from './types.js';

type DealOpened = Extract<ExampleExchangeEvent, { type: 'dealOpened' }>;
type DealClosed = Extract<ExampleExchangeEvent, { type: 'dealClosed' }>;

/**
 * Sprint 3 Task D: turns the raw event list into the ordered set of real
 * deals safe to compare bitbot's own entry timing against. A deal is
 * excluded from emission when the immediately-preceding deal has no known
 * real close (a runaway-cancelled deal — ExampleExchange sends no notification for
 * that cancellation, confirmed with the user, so the search window's start
 * boundary would be unknowable for whatever comes right after it).
 *
 * Exclusion from emission and "is this deal's own close known" are
 * independent facts — an excluded deal's own real close (if it has one)
 * still becomes the segmentStartMs boundary for the NEXT deal. Getting this
 * wrong (clearing/skipping the close tracker on an excluded deal) silently
 * widens the next deal's search window back to windowStartMs instead of the
 * excluded deal's real close — segments.length stays correct so a bare
 * count assertion won't catch it; only the boundary value does (see
 * dealSegments.test.ts's two-runaways-in-a-row case).
 */
export function buildDealSegments(
  events: readonly ExampleExchangeEvent[],
  windowStartMs: number,
  windowEndMs: number,
): DealSegment[] {
  const opened = events
    .filter((e): e is DealOpened => e.type === 'dealOpened')
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  const closedByDealId = new Map<string, DealClosed>(
    events.filter((e): e is DealClosed => e.type === 'dealClosed').map((e) => [e.dealId, e]),
  );

  const seenDealIds = new Set<string>();
  const segments: DealSegment[] = [];

  let previousDealRealCloseMs: number | null = null;
  let previousDealWasRunaway = false;

  for (const [i, deal] of opened.entries()) {
    if (seenDealIds.has(deal.dealId)) {
      throw new Error(`buildDealSegments: duplicate dealOpened for dealId "${deal.dealId}"`);
    }
    seenDealIds.add(deal.dealId);

    if (!previousDealWasRunaway) {
      // segmentEndMs is the next REAL dealOpened, chronologically, whether
      // or not that next deal is itself excluded from emission — Survivor
      // is always exactly one deal at a time (confirmed: 0 overlaps in the
      // real data), so the next real open is when bitbot's own deal loop
      // would have stopped watching for THIS entry regardless of whether
      // the next deal ends up being a reportable one.
      const next = opened[i + 1];
      segments.push({
        dealId: deal.dealId,
        realOpenMs: deal.timestamp,
        segmentStartMs: previousDealRealCloseMs ?? windowStartMs,
        segmentEndMs: next ? next.timestamp : windowEndMs,
      });
    }

    const close = closedByDealId.get(deal.dealId);
    previousDealWasRunaway = close === undefined;
    if (close !== undefined) {
      previousDealRealCloseMs = close.timestamp;
    }
  }

  return segments;
}
