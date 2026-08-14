import type { ExchangeAdapter } from '../exchange/types.js';

export interface NetBreakdown {
  grossProfit: number;
  totalFees: number;
  totalFunding: number;
  netProfit: number;
}

/** `ETH/USDT:USDT` -> `USDT`. USDM perps only (MVP scope) — always a `<base>/<quote>:<settle>` symbol. */
function parseQuoteCurrency(symbol: string): string {
  const [, quotePart] = symbol.split('/');
  const quoteCurrency = quotePart?.split(':')[0];
  if (!quoteCurrency) {
    throw new Error(`computeNet: cannot parse quote currency from symbol '${symbol}'`);
  }
  return quoteCurrency;
}

/**
 * MVP §7, §13.4: NET = gross profit - fees (both legs) + funding, over a
 * deal's whole lifetime. Deliberately no upper time bound — see the Slice
 * 10 review record: bounding to a captured `closedAt` risked excluding the
 * exit trade itself (its exchange timestamp can land a beat after the tick
 * that detected the fill), which is the single largest fee of the deal.
 * Safe to sum everything from `since` onward specifically because MVP scope
 * guarantees one deal at a time AND this is always called synchronously as
 * part of closing THIS deal, before any next deal could possibly exist.
 *
 * Fees are taken as observed (fee.cost in fee.currency) per trade, never
 * estimated from a rate — a fee paid in a non-quote currency (e.g. a BNB
 * discount) can't be safely summed as if it were already in the quote
 * currency without a conversion rate this adapter doesn't provide, so it's
 * excluded from totalFees with a loud WARN rather than silently mis-summed.
 * Exclusion UNDERSTATES totalFees (OVERSTATES netProfit) — the honest
 * direction of the gap: never pretend a fee is smaller or nonexistent.
 */
export async function computeNet(
  adapter: ExchangeAdapter,
  symbol: string,
  since: number,
): Promise<NetBreakdown> {
  const quoteCurrency = parseQuoteCurrency(symbol);

  const trades = await adapter.fetchTrades(symbol, since);
  let grossProfit = 0;
  let totalFees = 0;
  for (const trade of trades) {
    grossProfit += trade.side === 'sell' ? trade.cost : -trade.cost;
    if (trade.feeCurrency !== quoteCurrency) {
      console.warn(
        `computeNet: trade fee in non-quote currency '${trade.feeCurrency}' (expected '${quoteCurrency}') — excluded from NET, conversion not implemented`,
      );
      continue;
    }
    totalFees += trade.feeCost;
  }

  const fundingHistory = await adapter.fetchFundingHistory(symbol, since);
  const totalFunding = fundingHistory.reduce((sum, entry) => sum + entry.amount, 0);

  const netProfit = grossProfit - totalFees + totalFunding;
  return { grossProfit, totalFees, totalFunding, netProfit };
}
