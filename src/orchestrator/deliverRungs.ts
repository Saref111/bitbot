import type { DeliverRungsParams, GridOrderMutation } from './types.js';

/**
 * MVP §4.3: only `partial_placement` (K) rungs are ever resting on the
 * exchange at once; `null` means all of them. Places exchange orders for
 * however many `pending` rungs (ascending rungIndex) are needed to top the
 * live count back up to K, but does NOT write the DB itself — it returns
 * the resulting mutations so the caller (runDeal) can fold them into that
 * tick's single transaction alongside everything else (PLAN.md: one
 * transaction per tick).
 */
export async function deliverNextRungs(params: DeliverRungsParams): Promise<GridOrderMutation[]> {
  const { adapter, config, gridOrders, now } = params;
  const target = config.grid.partial_placement ?? config.grid.orders;
  const liveCount = gridOrders.filter((row) => row.status === 'placed').length;
  const slotsAvailable = target - liveCount;
  if (slotsAvailable <= 0) return [];

  const nextPending = gridOrders
    .filter((row) => row.status === 'pending')
    .slice()
    .sort((a, b) => a.rungIndex - b.rungIndex)
    .slice(0, slotsAvailable);

  const mutations: GridOrderMutation[] = [];
  for (const rung of nextPending) {
    await adapter.createOrder({
      symbol: config.symbol,
      side: 'buy',
      type: 'limit',
      amount: rung.size,
      price: rung.price,
      clientOrderId: rung.clientOrderId,
    });
    mutations.push({
      clientOrderId: rung.clientOrderId,
      patch: { status: 'placed', placedAt: now() },
    });
  }
  return mutations;
}
