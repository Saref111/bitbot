import { type GridPlan } from '../grid/index.js';
import type { GridReadyResult, MarketInfo, ReadyRung } from './types.js';

function cleanFloat(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(value.toFixed(decimals));
}

// ccxt's priceToPrecision uses ROUND (nearest) — confirmed ccxt-unified
// across exchanges, not a Binance-specific convention: the method is
// defined ONLY in base/Exchange.js (priceToPrecision, ~line 6569, calling
// decimalToPrecision(price, ROUND, ...)); neither bybit.js nor binance.js
// declares its own priceToPrecision override (grepped both — each only
// CALLS the inherited base method). Confirmed for Bybit, Sprint 4 Task C
// Slice C5.
function roundPriceToTick(price: number, tickSize: number): number {
  return cleanFloat(Math.round(price / tickSize) * tickSize, tickSize);
}

// ccxt's amountToPrecision uses TRUNCATE (down), not ROUND — same
// ccxt-unified base/Exchange.js method (~line 6580), confirmed neither
// bybit.js nor binance.js overrides it either (Slice C5, same grep as
// above). Matching that here (rather than rounding to nearest) keeps this
// pre-flight minNotional/minQty check (Slice C2b) accurate to what will
// actually be submitted. Rounding size UP instead would risk this check
// passing on a value the exchange then truncates back below the real
// floor, rejecting the order.
function truncateSizeToStep(size: number, stepSize: number): number {
  return cleanFloat(Math.floor(size / stepSize) * stepSize, stepSize);
}

/**
 * MVP §8, §13.3: round each rung's price/size to the exchange's
 * tickSize/stepSize before placing; if any rung's rounded notional falls
 * under minNotional, or its size falls under minQty, reject the WHOLE grid
 * (not just that one rung) since a partial grid would no longer match
 * projectGrid's computed distribution.
 *
 * Sprint 4 Task C, Slice C2b: minNotional (dollar floor, Binance-style) and
 * minQty (contract-quantity floor, Bybit-style) are two differently-shaped
 * constraints — no single conversion between them holds across a grid whose
 * rungs sit at different prices (see the Slice C2 review for why
 * minQty*price can't be folded into a fixed minNotional). Each exchange
 * populates only the field it actually enforces; the other is null and its
 * check is skipped.
 */
export function makeGridExchangeReady(plan: GridPlan, market: MarketInfo): GridReadyResult {
  const rungs: ReadyRung[] = [];

  for (const rung of plan.rungs) {
    const price = roundPriceToTick(rung.price, market.tickSize);
    const size = truncateSizeToStep(rung.size, market.stepSize);
    const notionalUsdt = price * size;

    if (market.minNotional != null && notionalUsdt < market.minNotional) {
      return {
        ok: false,
        reason: `rung ${String(rung.index)} notional ${String(notionalUsdt)} is below minNotional ${String(market.minNotional)}`,
        rungIndex: rung.index,
      };
    }

    if (market.minQty != null && size < market.minQty) {
      return {
        ok: false,
        reason: `rung ${String(rung.index)} size ${String(size)} is below minQty ${String(market.minQty)}`,
        rungIndex: rung.index,
      };
    }

    rungs.push({ index: rung.index, price, size, notionalUsdt, clientOrderId: rung.clientOrderId });
  }

  return { ok: true, rungs };
}
