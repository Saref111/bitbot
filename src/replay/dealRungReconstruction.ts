import type { ExampleExchangeEvent, ReconstructedRung } from './types.js';

type OrderFilled = Extract<ExampleExchangeEvent, { type: 'orderFilled' }>;

/**
 * Sprint 3 Task E: recovers each rung's OWN (not cumulative) price/size/
 * notional from a real deal's orderFilled events. `sumBase`/`notionalUsdt`
 * are cumulative totals since deal-open (confirmed against the raw
 * Telegram text: sumBase*avgPrice ≈ notionalUsdt at every step) — rung k's
 * own values are the difference between its cumulative fields and rung
 * (k-1)'s. `firstOrderFilled` events are ignored: `orderFilled` already
 * has a complete entry for rung 1 too (trivially equal to its own
 * cumulative fields, since nothing preceded it).
 */
export function reconstructDealRungs(
  events: readonly ExampleExchangeEvent[],
  dealId: string,
): ReconstructedRung[] {
  const sorted = events
    .filter((e): e is OrderFilled => e.type === 'orderFilled' && e.dealId === dealId)
    .slice()
    .sort((a, b) => a.rung - b.rung);

  for (const [i, event] of sorted.entries()) {
    if (event.rung !== i + 1) {
      throw new Error(
        `reconstructDealRungs: deal "${dealId}" has a gap or duplicate in its rung sequence — got rungs [${sorted.map((e) => String(e.rung)).join(',')}], expected a contiguous 1..k run`,
      );
    }
  }

  const rungs: ReconstructedRung[] = [];
  let prevSumBase = 0;
  let prevNotional = 0;
  for (const event of sorted) {
    const size = event.sumBase - prevSumBase;
    const notionalUsdt = event.notionalUsdt - prevNotional;
    if (!(size > 0)) {
      throw new Error(
        `reconstructDealRungs: deal "${dealId}" rung ${String(event.rung)} has non-positive reconstructed size (${String(size)}) — broken cumulative-field invariant`,
      );
    }
    rungs.push({ index: event.rung, price: notionalUsdt / size, size, notionalUsdt });
    prevSumBase = event.sumBase;
    prevNotional = event.notionalUsdt;
  }

  return rungs;
}
