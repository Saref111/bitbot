import { updateDeal } from '../storage/dealRepository.js';
import { updateExitOrderStatus } from '../storage/exitOrderRepository.js';
import { decide } from '../strategy/decide.js';
import { pollUntil } from './pollUntil.js';
import type { OrchestratorContext } from './types.js';
import type { DealCloseReason } from '../storage/types.js';

export interface CloseDealParams extends OrchestratorContext {
  dealId: string;
  avgEntry: number;
  filledRungsCount: number;
  exitClientOrderId: string;
  stopLossClientOrderId: string | null;
  pollIntervalMs?: number;
  fillTimeoutMs?: number;
}

export interface CloseDealResult {
  dealId: string;
  closeReason: DealCloseReason;
  closedAt: number;
}

/**
 * MVP §5 (ACTIVE -> SETTLING): waits for whichever exit order (TP or SL)
 * fills first, cancels everything else still resting for the symbol, and
 * settles the deal. NET/reinvest accounting is Slice 10, not here.
 *
 * Slice 7 scope note: this only knows about a single TP/SL pair and never
 * re-enters ACTIVE. Slice 9's real ACTIVE state also has to react to
 * further grid-rung fills (averaging, TP/SL reprice) while waiting for the
 * close — a case this function doesn't handle at all. Treat this as
 * scaffolding to replace alongside openDeal.ts, not a base to extend.
 */
export async function closeDeal(params: CloseDealParams): Promise<CloseDealResult> {
  const {
    adapter,
    db,
    config,
    now,
    dealId,
    avgEntry,
    filledRungsCount,
    exitClientOrderId,
    stopLossClientOrderId,
  } = params;
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const fillTimeoutMs = params.fillTimeoutMs ?? 60_000;

  const exitOrderIds = [exitClientOrderId, stopLossClientOrderId].filter(
    (id): id is string => id !== null,
  );

  const filledExitId = await pollUntil<string>(
    async () => {
      const openOrders = await adapter.fetchOpenOrders(config.symbol);
      const openClientOrderIds = new Set(openOrders.map((order) => order.clientOrderId));
      return exitOrderIds.find((id) => !openClientOrderIds.has(id)) ?? null;
    },
    { intervalMs: pollIntervalMs, timeoutMs: fillTimeoutMs },
  );

  const event = filledExitId === exitClientOrderId ? 'tp_filled' : 'sl_filled';
  const intent = decide({ config, filledRungsCount, avgEntry, event });
  if (intent.type !== 'close') {
    throw new Error(`closeDeal: expected decide() to return 'close', got '${intent.type}'`);
  }

  // Slice 9 TODO: cancelAll cancels the remaining grid_order rows and the
  // other exit_order (SL if TP filled, or vice versa) on the exchange, but
  // their DB rows stay 'placed' — exchange and DB disagree after this call.
  // Fine for this scaffolding (nothing reads their status again before the
  // deal ends), but the real state machine must mark them 'cancelled' here.
  await adapter.cancelAll(config.symbol);

  const closedAt = now();
  const closeReason: DealCloseReason = intent.reason === 'take_profit' ? 'tp' : 'sl';
  updateDeal(db, dealId, { status: 'SETTLING', closeReason, closedAt });
  updateExitOrderStatus(db, filledExitId, { status: 'filled', filledAt: closedAt });

  return { dealId, closeReason, closedAt };
}
