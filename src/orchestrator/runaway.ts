import type { Direction } from '../config/index.js';

/**
 * MVP §5 (GRID_PLACED, "підтяжка"): before the first fill, if price runs
 * away from P_entry by runaway_cancel_pct% (long: upward, away from the
 * grid's buy zone), the setup is stale — cancel and wait for a fresh signal
 * rather than leaving a grid resting indefinitely far from the market.
 *
 * currentPrice must be the LIVE price (including a still-forming 1m
 * candle), not a bar_close-gated one — this is about live price, unlike
 * signalEngine's filters. Do not reuse liveFeed's closed-bar guard here.
 *
 * Sprint 4 Task A: `direction` is a minimal parameter, not the whole
 * `Config` (this function only ever needed three numbers) — the caller
 * passes `config.direction`, same source as everywhere else. LONG grid
 * sits below P_entry, so "away" is upward; SHORT grid sits above, so
 * "away" is downward — the comparison direction mirrors, not just the sign
 * inside it.
 */
export function shouldCancelForRunaway(
  pEntry: number,
  currentPrice: number,
  runawayCancelPct: number,
  direction: Direction,
): boolean {
  return direction === 'long'
    ? currentPrice >= pEntry * (1 + runawayCancelPct / 100)
    : currentPrice <= pEntry * (1 - runawayCancelPct / 100);
}
