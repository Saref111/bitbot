import {
  restoreDeal,
  updateDeal,
  updateGridOrderStatus,
  insertExitOrder,
  runInTransaction,
  appendEvent,
} from '../storage/index.js';
import type { NewExitOrder, RestoredDeal } from '../storage/index.js';
import { runDealLoop } from './runDeal.js';
import type { RecoverDealParams, RecoverDealResult } from './types.js';

function assertNever(value: never): never {
  throw new Error(`recoverDeal: unhandled deal status: ${String(value)}`);
}

function parseExitType(dealId: string, clientOrderId: string): 'tp' | 'sl' | null {
  for (const type of ['tp', 'sl'] as const) {
    const prefix = `${dealId}-${type}-`;
    if (clientOrderId.startsWith(prefix) && /^\d+$/.test(clientOrderId.slice(prefix.length))) {
      return type;
    }
  }
  return null;
}

/**
 * Closes the "exchange ahead of DB" window: runDeal's createOrder calls
 * always happen BEFORE the tick's DB write commits, so a crash in between
 * leaves an order genuinely resting on the exchange that the DB doesn't
 * know about yet — invisible to reconcileTick, which only ever looks at
 * rows already marked 'placed'. Two concrete shapes:
 *  - a grid rung: the row always exists (the whole grid is inserted
 *    upfront as 'pending' at GRID_PLACED), just stuck at 'pending' instead
 *    of 'placed' — promote it once we see it resting live.
 *  - a TP/SL: no row exists at all yet (exit_order rows are only inserted
 *    once we know we're creating one) — recognized by the deterministic
 *    `${dealId}-tp-N` / `${dealId}-sl-N` naming and reconstructed straight
 *    from the live order's own price/amount.
 *
 * Known residual gap: a 'pending' rung that was BOTH created on the
 * exchange AND fully filled-and-gone again within the same downtime window
 * won't be caught here (fetchOpenOrders only shows currently-resting
 * orders) — it resolves safely via reconcileTick's own leftover-budget
 * check on the first live tick (position_diverged -> confirmed HALT), not
 * silently, but it is a real gap. Closing it would need an order-history
 * lookup this adapter doesn't have; not adding that surface without
 * verifying it first.
 */
async function reconcileOrphans(params: RecoverDealParams, restored: RestoredDeal): Promise<void> {
  const { adapter, db, config, now, dealId } = params;
  const openOrders = await adapter.fetchOpenOrders(config.symbol);
  const openByClientOrderId = new Map(openOrders.map((order) => [order.clientOrderId, order]));

  const promotions = restored.gridOrders
    .filter((row) => row.status === 'pending')
    .flatMap((row) => {
      const live = openByClientOrderId.get(row.clientOrderId);
      return live ? [{ clientOrderId: row.clientOrderId, filledSize: live.filled }] : [];
    });

  const knownExitClientOrderIds = new Set(restored.exitOrders.map((row) => row.clientOrderId));
  const orphanedExits: NewExitOrder[] = [];
  for (const order of openOrders) {
    if (knownExitClientOrderIds.has(order.clientOrderId)) continue;
    const type = parseExitType(dealId, order.clientOrderId);
    if (!type) continue;
    orphanedExits.push({
      dealId,
      type,
      clientOrderId: order.clientOrderId,
      price: order.price,
      amount: order.amount,
      createdAt: now(),
    });
  }

  if (promotions.length === 0 && orphanedExits.length === 0) return;

  runInTransaction(db, () => {
    for (const promotion of promotions) {
      updateGridOrderStatus(db, promotion.clientOrderId, {
        status: 'placed',
        placedAt: now(),
        filledSize: promotion.filledSize,
      });
    }
    for (const exitOrder of orphanedExits) {
      insertExitOrder(db, exitOrder);
    }
  });
}

/**
 * MVP §5/§9 (restart bullet): reconstructs in-flight state after a restart
 * and resumes driving the deal.
 */
export async function recoverDeal(params: RecoverDealParams): Promise<RecoverDealResult> {
  const { db, dealId, now } = params;
  const restored = restoreDeal(db, dealId);
  if (!restored) return { outcome: 'no-deal' };

  switch (restored.deal.status) {
    case 'SETTLING':
      return { outcome: 'closed', closeReason: restored.deal.closeReason ?? 'error' };

    case 'HALTED':
      return { outcome: 'halted', reason: 'deal was already HALTED before restart' };

    case 'WAITING_SIGNAL': {
      // Crashed in the narrow window before the grid was ever computed —
      // nothing to resume. Mark it terminal so a caller doesn't mistake
      // this half-started row for an in-flight deal; start a new dealId.
      const haltedAt = now();
      const reason = 'restart found WAITING_SIGNAL with no grid ever placed';
      updateDeal(db, dealId, { status: 'HALTED', closeReason: 'error', closedAt: haltedAt });
      appendEvent(db, { dealId, eventType: 'halted', payload: { reason }, createdAt: haltedAt });
      return { outcome: 'halted', reason };
    }

    case 'GRID_PLACED':
    case 'ACTIVE':
      await reconcileOrphans(params, restored);
      return runDealLoop(params);

    default:
      return assertNever(restored.deal.status);
  }
}
