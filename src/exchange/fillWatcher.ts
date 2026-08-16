import type { FillWatcher, WatchOrdersLike } from './types.js';

/**
 * MVP §13.5: wraps ccxt.pro's watchOrders as a pure "wake me on the next
 * order update" signal — the payload itself is discarded. This is
 * deliberately NOT a state source: runDealLoop's poll-driven reconcileTick
 * remains the only thing that decides what actually happened: it
 * re-derives full state from fetchOpenOrders/fetchPosition on every tick,
 * WS-triggered or not. See runDeal.ts's race helper for how a failed watch
 * degrades to the plain poll cadence instead of crashing the loop.
 */
export function createBinanceFillWatcher(client: WatchOrdersLike): FillWatcher {
  return {
    async next(symbol: string): Promise<void> {
      await client.watchOrders(symbol);
    },
  };
}
