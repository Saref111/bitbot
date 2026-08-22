import {
  getGridOrdersByDeal,
  getExitOrdersByDeal,
  getDeal,
  updateGridOrderStatus,
  updateExitOrderStatus,
  insertExitOrder,
  updateDeal,
  appendEvent,
  runInTransaction,
} from '../storage/index.js';
import { averageEntry } from '../grid/index.js';
import { decide } from '../strategy/index.js';
import { reconcileTick, contractsImpliedByDb } from './reconcile.js';
import { deliverNextRungs } from './deliverRungs.js';
import { reconcileExitTargets } from './exitTargets.js';
import { computeNet } from './computeNet.js';
import { haltSignature, advanceHaltGate, haltDeal, notifySafely } from './haltGate.js';
import type { Logger } from '../logging/index.js';
import type { DealCloseReason, GridOrderRow } from '../storage/index.js';
import type {
  ExitTargetMutation,
  OrchestratorContext,
  RunDealResult,
  TickContext,
} from './types.js';

function warnIfLiquidationEntersGrid(
  logger: Logger,
  gridRows: readonly GridOrderRow[],
  liquidationPrice: number | null,
): void {
  if (liquidationPrice === null) return;
  const deepest = gridRows
    .filter((row) => row.status !== 'cancelled')
    .reduce((min, row) => Math.min(min, row.price), Infinity);
  if (Number.isFinite(deepest) && liquidationPrice >= deepest) {
    // MVP §8: informational only. dealId comes from the child logger
    // bound at runDeal/recoverDeal/adoptExistingPosition (Sprint 3 Task H).
    logger.warn(
      { liquidationPrice, deepestRungPrice: deepest },
      "liquidation price has reached the grid's deepest resting rung",
    );
  }
}

function applyExitMutations(
  db: OrchestratorContext['db'],
  mutations: readonly ExitTargetMutation[],
): void {
  for (const mutation of mutations) {
    if (mutation.kind === 'cancelled') {
      updateExitOrderStatus(db, mutation.clientOrderId, {
        status: 'cancelled',
        cancelledAt: mutation.cancelledAt,
      });
    } else {
      insertExitOrder(db, mutation.exitOrder);
    }
  }
}

export async function activeTick(ctx: TickContext): Promise<'continue' | RunDealResult> {
  const { adapter, db, config, now, dealId, gate, haltConfirmationTicks, logger, notifier } = ctx;

  const [openOrders, position] = await Promise.all([
    adapter.fetchOpenOrders(config.symbol),
    adapter.fetchPosition(config.symbol),
  ]);
  const gridRows = getGridOrdersByDeal(db, dealId);
  const exitRows = getExitOrdersByDeal(db, dealId);
  const placedGrid = gridRows.filter((row) => row.status === 'placed');
  const placedExit = exitRows.filter((row) => row.status === 'placed');
  const previousContracts = contractsImpliedByDb(gridRows, exitRows);

  warnIfLiquidationEntersGrid(logger, gridRows, position.liquidationPrice);

  const events = reconcileTick({
    gridOrders: placedGrid.map((row) => ({
      clientOrderId: row.clientOrderId,
      rungIndex: row.rungIndex,
      price: row.price,
      size: row.size,
      filledSize: row.filledSize,
    })),
    exitOrders: placedExit.map((row) => ({
      clientOrderId: row.clientOrderId,
      type: row.type,
      amount: row.amount,
      filledSize: row.filledSize,
    })),
    previousContracts,
    openOrders,
    position,
  });

  const signature = haltSignature(events);
  if (advanceHaltGate(gate, signature, haltConfirmationTicks)) {
    return haltDeal(ctx, signature ?? 'unknown anomaly');
  }

  const partials = events.filter((event) => event.kind === 'partial_fill');
  const rungFilledEvents = events.filter((event) => event.kind === 'rung_filled');
  const exitFilledEvent = events.find((event) => event.kind === 'exit_filled');

  const deal = getDeal(db, dealId);
  if (!deal) throw new Error(`runDeal: deal ${dealId} not found`);

  if (exitFilledEvent) {
    const newFilledRungsCount = deal.filledRungsCount + rungFilledEvents.length;
    const fillsSoFar = gridRows
      .filter((row) => row.status === 'filled')
      .map((row) => ({ price: row.fillPrice ?? row.price, size: row.size }))
      .concat(
        rungFilledEvents.map((event) => {
          const row = gridRows.find((r) => r.clientOrderId === event.clientOrderId);
          if (!row) throw new Error(`runDeal: no grid_order row for ${event.clientOrderId}`);
          return { price: event.fillPrice, size: row.size };
        }),
      );
    const avgEntry = averageEntry(fillsSoFar);

    const closeEvent = exitFilledEvent.exitType === 'tp' ? 'tp_filled' : 'sl_filled';
    const intent = decide({
      config,
      filledRungsCount: newFilledRungsCount,
      avgEntry,
      event: closeEvent,
    });
    if (intent.type !== 'close') {
      throw new Error(
        `runDeal: expected decide() to return 'close' on an exit fill, got '${intent.type}'`,
      );
    }

    await adapter.cancelAll(config.symbol);

    const closeReason: DealCloseReason = intent.reason === 'take_profit' ? 'tp' : 'sl';
    const haltAfterLoss = closeReason === 'sl' && config.halt_after_loss;
    const closedAt = now();

    // MVP §7, §13.4: computed here (network calls, outside the sync
    // transaction below), not bounded by closedAt on the upper end — see
    // computeNet.ts. If it fails (e.g. network drop right after cancelAll),
    // the position is ALREADY closed on the exchange either way; blocking
    // the SETTLING write on this would leave the deal stuck in ACTIVE with
    // a closed position and no way forward. Degrade instead: close with
    // netProfit: null, which resolveDeposit.ts already treats as "no
    // reinvest growth this cycle" — same safe path as a loss.
    let netProfit: number | null;
    try {
      netProfit = (await computeNet(adapter, config.symbol, deal.openedAt, logger)).netProfit;
    } catch (error) {
      logger.warn({ error }, 'computeNet failed, closing with netProfit: null');
      netProfit = null;
    }

    runInTransaction(db, () => {
      for (const partial of partials) {
        const patch = { status: 'placed' as const, filledSize: partial.filledSize };
        if (partial.side === 'grid') updateGridOrderStatus(db, partial.clientOrderId, patch);
        else updateExitOrderStatus(db, partial.clientOrderId, patch);
      }
      for (const event of rungFilledEvents) {
        updateGridOrderStatus(db, event.clientOrderId, {
          status: 'filled',
          filledAt: closedAt,
          fillPrice: event.fillPrice,
        });
      }
      updateExitOrderStatus(db, exitFilledEvent.clientOrderId, {
        status: 'filled',
        filledAt: closedAt,
      });

      const filledClientOrderIds = new Set(rungFilledEvents.map((event) => event.clientOrderId));
      for (const row of gridRows) {
        if (
          (row.status === 'placed' || row.status === 'pending') &&
          !filledClientOrderIds.has(row.clientOrderId)
        ) {
          updateGridOrderStatus(db, row.clientOrderId, {
            status: 'cancelled',
            cancelledAt: closedAt,
          });
        }
      }
      for (const row of exitRows) {
        if (row.status === 'placed' && row.clientOrderId !== exitFilledEvent.clientOrderId) {
          updateExitOrderStatus(db, row.clientOrderId, {
            status: 'cancelled',
            cancelledAt: closedAt,
          });
        }
      }

      updateDeal(db, dealId, {
        status: haltAfterLoss ? 'HALTED' : 'SETTLING',
        filledRungsCount: newFilledRungsCount,
        closeReason,
        closedAt,
        netProfit,
      });
      if (haltAfterLoss) {
        appendEvent(db, {
          dealId,
          eventType: 'halted_after_loss',
          payload: { closeReason },
          createdAt: closedAt,
        });
      }
    });

    logger.info({ closeReason, netProfit }, 'deal closed');
    await notifySafely(
      logger,
      notifier,
      `Deal ${dealId} closed (${closeReason}), NET=${netProfit === null ? 'unknown' : String(netProfit)}`,
    );
    if (haltAfterLoss) {
      logger.error('deal HALTED after a loss (halt_after_loss)');
      await notifySafely(
        logger,
        notifier,
        `HALTED: deal ${dealId} — closed at a loss, halt_after_loss is set`,
      );
    }

    return { outcome: 'closed', closeReason };
  }

  const newFilledRungsCount = deal.filledRungsCount + rungFilledEvents.length;
  const gridRowsAfterFill = gridRows.map((row) => {
    const filled = rungFilledEvents.some((event) => event.clientOrderId === row.clientOrderId);
    return filled ? { ...row, status: 'filled' as const } : row;
  });
  const deliverMutations =
    rungFilledEvents.length > 0
      ? await deliverNextRungs({ adapter, config, gridOrders: gridRowsAfterFill, now })
      : [];

  let exitMutations: ExitTargetMutation[] = [];
  if (position.contracts > 0 && position.entryPrice !== null) {
    const intent = decide({
      config,
      filledRungsCount: newFilledRungsCount,
      avgEntry: position.entryPrice,
      event: 'rung_filled',
    });
    if (intent.type === 'close') {
      throw new Error("runDeal: decide() unexpectedly returned 'close' outside an exit fill");
    }
    exitMutations = await reconcileExitTargets({
      adapter,
      config,
      dealId,
      desiredTakeProfitPrice: intent.takeProfitPrice,
      desiredStopLossPrice: intent.stopLossPrice,
      positionContracts: position.contracts,
      restingExitOrders: placedExit,
      allExitOrders: exitRows,
      now,
    });
  }

  if (
    partials.length + rungFilledEvents.length + deliverMutations.length + exitMutations.length ===
    0
  ) {
    return 'continue';
  }

  runInTransaction(db, () => {
    for (const partial of partials) {
      const patch = { status: 'placed' as const, filledSize: partial.filledSize };
      if (partial.side === 'grid') updateGridOrderStatus(db, partial.clientOrderId, patch);
      else updateExitOrderStatus(db, partial.clientOrderId, patch);
    }
    for (const event of rungFilledEvents) {
      updateGridOrderStatus(db, event.clientOrderId, {
        status: 'filled',
        filledAt: now(),
        fillPrice: event.fillPrice,
      });
    }
    for (const mutation of deliverMutations) {
      updateGridOrderStatus(db, mutation.clientOrderId, mutation.patch);
    }
    applyExitMutations(db, exitMutations);
    if (rungFilledEvents.length > 0) {
      updateDeal(db, dealId, { filledRungsCount: newFilledRungsCount });
    }
  });

  if (rungFilledEvents.length > 0) {
    // MVP §13.6: "ордер спрацював" / "усереднення" — a safety-order fill is
    // both at once, one notification covers it.
    logger.info(
      { filledRungsCount: newFilledRungsCount, avgEntry: position.entryPrice },
      'grid rung filled (averaging)',
    );
    await notifySafely(
      logger,
      notifier,
      `Deal ${dealId}: rung filled, avg now ${String(position.entryPrice)}`,
    );
  }

  return 'continue';
}
