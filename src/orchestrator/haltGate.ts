import { runInTransaction, updateDeal, appendEvent } from '../storage/index.js';
import type { Logger } from '../logging/index.js';
import type { Notifier } from '../notify/index.js';
import type { ReconcileEvent } from './reconcileTypes.js';
import type { HaltGateState, RunDealResult, TickContext } from './types.js';

/** MVP §13.6: notifications are a best-effort side channel — a failed send must never block the state machine. */
export async function notifySafely(
  logger: Logger,
  notifier: Notifier,
  message: string,
): Promise<void> {
  try {
    await notifier.notify(message);
  } catch (error) {
    logger.warn({ error }, 'notifySafely: notifier.notify failed');
  }
}

export function haltSignature(events: readonly ReconcileEvent[]): string | null {
  const haltEvents = events.filter(
    (event) =>
      event.kind === 'rung_cancelled' ||
      event.kind === 'exit_cancelled' ||
      event.kind === 'position_diverged',
  );
  if (haltEvents.length === 0) return null;
  return haltEvents
    .map((event) =>
      event.kind === 'position_diverged'
        ? `diverged:${event.detail}`
        : `${event.kind}:${event.clientOrderId}`,
    )
    .sort()
    .join('|');
}

/** Mutates gate in place; returns true once the SAME anomaly has repeated haltConfirmationTicks times in a row. */
export function advanceHaltGate(
  gate: HaltGateState,
  signature: string | null,
  threshold: number,
): boolean {
  if (signature === null) {
    gate.lastSignature = null;
    gate.streak = 0;
    return false;
  }
  gate.streak = signature === gate.lastSignature ? gate.streak + 1 : 1;
  gate.lastSignature = signature;
  return gate.streak >= threshold;
}

export async function haltDeal(ctx: TickContext, reason: string): Promise<RunDealResult> {
  const { adapter, db, config, dealId, now, logger, notifier } = ctx;
  // HALTED means "stop and wait for a human" — resting orders left live
  // could still execute unattended, which defeats the point. Cancel them;
  // never touch an open position itself (closing it is a real decision a
  // human should make, not something to force on an ambiguous halt).
  await adapter.cancelAll(config.symbol);
  const haltedAt = now();
  runInTransaction(db, () => {
    updateDeal(db, dealId, { status: 'HALTED', closeReason: 'error', closedAt: haltedAt });
    appendEvent(db, { dealId, eventType: 'halted', payload: { reason }, createdAt: haltedAt });
  });
  logger.error({ dealId, reason }, 'deal HALTED');
  // MVP §13.6: "HALTED дублюється гучною Telegram-нотифікацією" — this event must never be missed.
  await notifySafely(logger, notifier, `HALTED: deal ${dealId} — ${reason}`);
  return { outcome: 'halted', reason };
}
