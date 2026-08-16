import { type GridPlan } from '../grid/index.js';
import type { GridReadyResult, MarketInfo, ReadyRung } from './types.js';

function cleanFloat(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(value.toFixed(decimals));
}

// ccxt's priceToPrecision uses ROUND (nearest) for Binance.
function roundPriceToTick(price: number, tickSize: number): number {
  return cleanFloat(Math.round(price / tickSize) * tickSize, tickSize);
}

// ccxt's amountToPrecision uses TRUNCATE (down), not ROUND, for Binance —
// matching that here (rather than rounding to nearest) keeps this
// pre-flight minNotional check accurate to what will actually be submitted.
// Rounding size UP instead would risk this check passing on a notional the
// exchange then truncates back below minNotional, rejecting the real order.
function truncateSizeToStep(size: number, stepSize: number): number {
  return cleanFloat(Math.floor(size / stepSize) * stepSize, stepSize);
}

/**
 * MVP §8, §13.3: round each rung's price/size to the exchange's
 * tickSize/stepSize before placing; if any rung's rounded notional falls
 * under minNotional, reject the WHOLE grid (not just that one rung) since a
 * partial grid would no longer match projectGrid's computed distribution.
 */
export function makeGridExchangeReady(plan: GridPlan, market: MarketInfo): GridReadyResult {
  const rungs: ReadyRung[] = [];

  for (const rung of plan.rungs) {
    const price = roundPriceToTick(rung.price, market.tickSize);
    const size = truncateSizeToStep(rung.size, market.stepSize);
    const notionalUsdt = price * size;

    if (notionalUsdt < market.minNotional) {
      return {
        ok: false,
        reason: `rung ${String(rung.index)} notional ${String(notionalUsdt)} is below minNotional ${String(market.minNotional)}`,
        rungIndex: rung.index,
      };
    }

    rungs.push({ index: rung.index, price, size, notionalUsdt, clientOrderId: rung.clientOrderId });
  }

  return { ok: true, rungs };
}
