import { OrderNotFoundError } from '../exchange/index.js';
import type { ExitOrderRow } from '../storage/index.js';
import { PRICE_EPS } from './constants.js';
import type { ExitTargetMutation, ReconcileExitTargetsParams } from './types.js';

/**
 * MVP §5/§6 (ACTIVE, "переставляємо TP (і SL) на нові рівні"): a level-check
 * run every ACTIVE tick (after that tick's fills are already applied, so
 * avgEntry is fresh) rather than a one-shot triggered by a specific fill
 * event. Self-healing by construction: if cancelOrder races against the
 * exit order filling at that exact moment (OrderNotFoundError), this tick
 * simply does nothing for it — the NEXT tick's reconcileTick will see it
 * gone with contracts down accordingly and classify it as exit_filled,
 * which is the correct outcome, not a bug to special-case around.
 *
 * Returns DB mutations rather than writing them (PLAN.md: one transaction
 * per tick, applied by the caller alongside everything else from that tick).
 */
export async function reconcileExitTargets(
  params: ReconcileExitTargetsParams,
): Promise<ExitTargetMutation[]> {
  const {
    adapter,
    config,
    dealId,
    desiredTakeProfitPrice,
    desiredStopLossPrice,
    positionContracts,
    restingExitOrders,
    allExitOrders,
    now,
  } = params;

  const desiredByType: Record<ExitOrderRow['type'], number | null> = {
    tp: desiredTakeProfitPrice,
    sl: desiredStopLossPrice,
  };

  const mutations: ExitTargetMutation[] = [];

  for (const row of restingExitOrders) {
    const desired = desiredByType[row.type];
    if (desired === null) continue;
    if (Math.abs(row.price - desired) <= PRICE_EPS) continue;

    try {
      await adapter.cancelOrder(config.symbol, row.clientOrderId);
    } catch (error) {
      if (error instanceof OrderNotFoundError) continue;
      throw error;
    }
    mutations.push({ kind: 'cancelled', clientOrderId: row.clientOrderId, cancelledAt: now() });

    const priorCount = allExitOrders.filter((o) => o.type === row.type).length;
    const newClientOrderId = `${dealId}-${row.type}-${String(priorCount)}`;
    await adapter.createOrder({
      symbol: config.symbol,
      side: 'sell',
      type: 'limit',
      amount: positionContracts,
      price: desired,
      clientOrderId: newClientOrderId,
      reduceOnly: true,
    });
    mutations.push({
      kind: 'inserted',
      exitOrder: {
        dealId,
        type: row.type,
        clientOrderId: newClientOrderId,
        price: desired,
        amount: positionContracts,
        createdAt: now(),
      },
    });
  }

  return mutations;
}
