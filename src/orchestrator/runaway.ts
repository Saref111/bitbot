/**
 * MVP §5 (GRID_PLACED, "підтяжка"): before the first fill, if price runs
 * away from P_entry by runaway_cancel_pct% (long: upward, away from the
 * grid's buy zone), the setup is stale — cancel and wait for a fresh signal
 * rather than leaving a grid resting indefinitely far from the market.
 *
 * currentPrice must be the LIVE price (including a still-forming 1m
 * candle), not a bar_close-gated one — this is about live price, unlike
 * signalEngine's filters. Do not reuse liveFeed's closed-bar guard here.
 */
export function shouldCancelForRunaway(
  pEntry: number,
  currentPrice: number,
  runawayCancelPct: number,
): boolean {
  return currentPrice >= pEntry * (1 + runawayCancelPct / 100);
}
