import type { DecideContext, Intent } from './types.js';

function assertNever(value: never): never {
  throw new Error(`decide: unhandled event: ${String(value)}`);
}

/**
 * MVP §5 (ACTIVE) / §6: on every grid fill, avg moves and TP (and SL, if
 * configured) get repositioned to it; on a TP/SL fill the deal closes. This
 * is a pure classifier over discrete fill events — it does NOT compare
 * against a live price itself, because TP/SL/grid orders are resting
 * reduceOnly/limit orders on the exchange; the exchange decides when they
 * fill, not this function.
 */
export function decide(context: DecideContext): Intent {
  const { config, filledRungsCount, avgEntry, event } = context;

  if (config.direction !== 'long') {
    throw new Error('decide: short direction is not implemented yet (see projectGrid)');
  }
  if (!(avgEntry > 0)) {
    throw new Error('decide: avgEntry must be positive');
  }
  if (filledRungsCount < 1) {
    throw new Error('decide: filledRungsCount must be at least 1 (a fill already happened)');
  }
  if (filledRungsCount > config.grid.orders) {
    throw new Error('decide: filledRungsCount must not exceed grid.orders');
  }

  switch (event) {
    case 'tp_filled':
      return { type: 'close', reason: 'take_profit' };

    case 'sl_filled':
      if (config.stop_loss === null) {
        throw new Error('decide: sl_filled event received but stop_loss is not configured');
      }
      return { type: 'close', reason: 'stop_loss' };

    case 'rung_filled': {
      const takeProfitPrice = avgEntry * (1 + config.take_profit_pct / 100);
      const stopLossPrice =
        config.stop_loss === null ? null : avgEntry * (1 - config.stop_loss / 100);

      return {
        type: filledRungsCount === 1 ? 'open' : 'safety',
        takeProfitPrice,
        stopLossPrice,
      };
    }

    default:
      return assertNever(event);
  }
}
