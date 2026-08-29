import type { ExampleExchangeEvent, ExitReconciliation, ExitReconciliationReport } from './types.js';

type DealClosed = Extract<ExampleExchangeEvent, { type: 'dealClosed' }>;
type OrderFilled = Extract<ExampleExchangeEvent, { type: 'orderFilled' }>;

/**
 * Sprint 3 Task F: cheap consistency check on the exit side — does the
 * profit Veles actually recorded for a take-profit close imply an exit
 * price consistent with `take_profit_pct%` PRICE movement from the deal's
 * average entry (MVP: take-profit is a price move, NOT leveraged ROI)?
 *
 * Only `dealClosed` events whose `closeReason` indicates a take-profit
 * close are checked — a stop-loss/manual/HALT close is expected to exit
 * at a different price by design, not a real oracle mismatch.
 */
export function reconcileExitPrices(
  events: readonly ExampleExchangeEvent[],
  takeProfitPct: number,
  tickSize: number,
  toleranceTicks: number,
): ExitReconciliationReport {
  const closedTakeProfit = events.filter(
    (e): e is DealClosed => e.type === 'dealClosed' && e.closeReason.includes('тейк-профітом'),
  );
  const orderFilledByDeal = new Map<string, OrderFilled[]>();
  for (const e of events) {
    if (e.type !== 'orderFilled') continue;
    const list = orderFilledByDeal.get(e.dealId) ?? [];
    list.push(e);
    orderFilledByDeal.set(e.dealId, list);
  }

  const deals: ExitReconciliation[] = closedTakeProfit.map((close) => {
    const fills = orderFilledByDeal.get(close.dealId);
    if (!fills || fills.length === 0) {
      throw new Error(
        `reconcileExitPrices: deal "${close.dealId}" closed via take-profit but has no orderFilled events`,
      );
    }
    const lastFill = fills.reduce((latest, f) => (f.rung > latest.rung ? f : latest));

    const avgEntryPrice = lastFill.avgPrice;
    const totalSize = lastFill.sumBase;
    const impliedExitPrice = avgEntryPrice + close.profitUsdt / totalSize;
    const targetExitPrice = avgEntryPrice * (1 + takeProfitPct / 100);
    const diffTicks = (impliedExitPrice - targetExitPrice) / tickSize;

    return {
      dealId: close.dealId,
      avgEntryPrice,
      totalSize,
      profitUsdt: close.profitUsdt,
      impliedExitPrice,
      targetExitPrice,
      diffTicks,
      withinTolerance: Math.abs(diffTicks) <= toleranceTicks,
    };
  });

  return {
    deals,
    matchedCount: deals.filter((d) => d.withinTolerance).length,
    totalCount: deals.length,
  };
}
