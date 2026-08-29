import { describe, expect, it } from 'vitest';
import { buildDealSegments } from '../../src/replay/dealSegments.js';
import type { ExampleExchangeEvent } from '../../src/replay/types.js';

function opened(dealId: string, timestamp: number): ExampleExchangeEvent {
  return { type: 'dealOpened', dealId, timestamp };
}

function closed(dealId: string, timestamp: number): ExampleExchangeEvent {
  return {
    type: 'dealClosed',
    dealId,
    timestamp,
    filledRungs: 1,
    rungTotal: 14,
    durationMs: timestamp,
    profitUsdt: 1,
    feeUsdt: 0.1,
    closeReason: 'тейк-профітом',
  };
}

const WINDOW_START = 0;
const HOUR = 60 * 60_000;

describe('buildDealSegments — Sprint 3 Task D', () => {
  it('builds a simple close-close-close chain with correct boundaries', () => {
    const events: ExampleExchangeEvent[] = [
      opened('a', 1 * HOUR),
      closed('a', 2 * HOUR),
      opened('b', 3 * HOUR),
      closed('b', 4 * HOUR),
      opened('c', 5 * HOUR),
      closed('c', 6 * HOUR),
    ];
    const windowEnd = 10 * HOUR;

    const segments = buildDealSegments(events, WINDOW_START, windowEnd);

    expect(segments).toEqual([
      { dealId: 'a', realOpenMs: 1 * HOUR, segmentStartMs: WINDOW_START, segmentEndMs: 3 * HOUR },
      { dealId: 'b', realOpenMs: 3 * HOUR, segmentStartMs: 2 * HOUR, segmentEndMs: 5 * HOUR },
      { dealId: 'c', realOpenMs: 5 * HOUR, segmentStartMs: 4 * HOUR, segmentEndMs: windowEnd },
    ]);
  });

  it('excludes exactly the deal immediately following a single runaway (no recorded close)', () => {
    const events: ExampleExchangeEvent[] = [
      opened('a', 1 * HOUR),
      closed('a', 2 * HOUR),
      opened('b', 3 * HOUR), // runaway — no closed('b', ...)
      opened('c', 5 * HOUR),
      closed('c', 6 * HOUR),
      opened('d', 7 * HOUR),
      closed('d', 8 * HOUR),
    ];
    const windowEnd = 10 * HOUR;

    const segments = buildDealSegments(events, WINDOW_START, windowEnd);

    const dealIds = segments.map((s) => s.dealId);
    expect(dealIds).toEqual(['a', 'b', 'd']); // 'c' excluded — follows runaway 'b'
    const dealD = segments.find((s) => s.dealId === 'd');
    // 'c' is excluded from the report, but its own real close (6h) is still
    // a valid boundary for 'd' — this is the exact rule the user's fix
    // targeted: exclusion from emission must not suppress updating the
    // "previous real close" tracker.
    expect(dealD?.segmentStartMs).toBe(6 * HOUR);

    // 'b's own segmentEndMs must be the next REAL dealOpened chronologically
    // ('c' at 5h), even though 'c' itself is excluded from the report — an
    // implementation that instead looks ahead to the next EMITTED deal ('d'
    // at 7h) would silently widen 'b's search window past 'c's real open.
    const dealB = segments.find((s) => s.dealId === 'b');
    expect(dealB?.segmentEndMs).toBe(5 * HOUR);
  });

  it('two runaways in a row: excludes exactly the deal after each, chain resolves once a real close is known again', () => {
    // Exact synthetic replica of the real chain
    // 1184838450(RUNAWAY) -> 1184843947(RUNAWAY) -> 1184919345(close) -> 1185269639(RUNAWAY)
    const events: ExampleExchangeEvent[] = [
      opened('deal0', 0 * HOUR),
      closed('deal0', 1 * HOUR),
      opened('deal1', 2 * HOUR), // RUNAWAY
      opened('deal2', 3 * HOUR), // RUNAWAY, follows RUNAWAY deal1 -> excluded
      opened('deal3', 4 * HOUR), // closes normally, follows RUNAWAY deal2 -> excluded
      closed('deal3', 5 * HOUR),
      opened('deal4', 6 * HOUR), // follows deal3, whose own real close (5h) is valid -> included
      closed('deal4', 7 * HOUR),
    ];
    const windowEnd = 10 * HOUR;

    const segments = buildDealSegments(events, WINDOW_START, windowEnd);

    const dealIds = segments.map((s) => s.dealId);
    expect(dealIds).toEqual(['deal0', 'deal1', 'deal4']);
    const deal4 = segments.find((s) => s.dealId === 'deal4');
    // The regression this test exists to catch: an implementation that
    // clears/fails-to-update the "previous real close" tracker on an
    // excluded-but-really-closed deal (deal3) would silently widen deal4's
    // search window back to WINDOW_START instead of deal3's real close (5h).
    expect(deal4?.segmentStartMs).toBe(5 * HOUR);
  });

  it('the first deal in the window uses windowStartMs as its segment start', () => {
    const events: ExampleExchangeEvent[] = [opened('a', 1 * HOUR), closed('a', 2 * HOUR)];

    const segments = buildDealSegments(events, WINDOW_START, 5 * HOUR);

    expect(segments[0]).toEqual({
      dealId: 'a',
      realOpenMs: 1 * HOUR,
      segmentStartMs: WINDOW_START,
      segmentEndMs: 5 * HOUR,
    });
  });

  it('the last deal in the window uses windowEndMs as its segment end', () => {
    const events: ExampleExchangeEvent[] = [opened('a', 1 * HOUR), closed('a', 2 * HOUR), opened('b', 3 * HOUR)];
    const windowEnd = 9 * HOUR;

    const segments = buildDealSegments(events, WINDOW_START, windowEnd);

    const dealB = segments.find((s) => s.dealId === 'b');
    expect(dealB?.segmentEndMs).toBe(windowEnd);
  });

  it('ignores a dealClosed with no matching dealOpened', () => {
    const events: ExampleExchangeEvent[] = [closed('orphan', 1 * HOUR), opened('a', 2 * HOUR), closed('a', 3 * HOUR)];

    const segments = buildDealSegments(events, WINDOW_START, 5 * HOUR);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.dealId).toBe('a');
  });

  it('throws on two dealOpened events for the same dealId', () => {
    const events: ExampleExchangeEvent[] = [opened('a', 1 * HOUR), opened('a', 2 * HOUR)];

    expect(() => buildDealSegments(events, WINDOW_START, 5 * HOUR)).toThrow(/dealId.*a/);
  });

  it('sorts events defensively instead of trusting input order', () => {
    const events: ExampleExchangeEvent[] = [
      closed('a', 2 * HOUR),
      opened('b', 3 * HOUR),
      opened('a', 1 * HOUR), // out of order on purpose
    ];

    const segments = buildDealSegments(events, WINDOW_START, 5 * HOUR);

    expect(segments.map((s) => s.dealId)).toEqual(['a', 'b']);
  });
});
