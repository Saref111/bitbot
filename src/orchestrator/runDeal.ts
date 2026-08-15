import { insertDeal, updateDeal, getDeal } from '../storage/dealRepository.js';
import { getGridOrdersByDeal, updateGridOrderStatus } from '../storage/gridOrderRepository.js';
import {
  getExitOrdersByDeal,
  insertExitOrder,
  updateExitOrderStatus,
} from '../storage/exitOrderRepository.js';
import { appendEvent } from '../storage/eventLogRepository.js';
import { placeGrid } from '../storage/placeGrid.js';
import { runInTransaction } from '../storage/transaction.js';
import { projectGrid } from '../grid/projectGrid.js';
import { averageEntry } from '../grid/averageEntry.js';
import { makeGridExchangeReady } from '../exchange/gridReady.js';
import { decide } from '../strategy/decide.js';
import { reconcileTick } from './reconcile.js';
import { shouldCancelForRunaway } from './runaway.js';
import { deliverNextRungs } from './deliverRungs.js';
import { reconcileExitTargets } from './exitTargets.js';
import { computeNet } from './computeNet.js';
import { resolveDepositUsdt } from './resolveDeposit.js';
import { createNoopLogger } from '../logging/logger.js';
import { createNoopNotifier } from '../notify/noopNotifier.js';
import { sleep } from '../util/time.js';
import type { GridOrderRow, ExitOrderRow, DealCloseReason } from '../storage/types.js';
import type { ReconcileEvent } from './reconcileTypes.js';
import type { ExitTargetMutation } from './exitTargets.js';
import type { OrchestratorContext } from './types.js';
import type { Logger } from '../logging/logger.js';
import type { Notifier } from '../notify/types.js';
import type { FillWatcher } from '../exchange/fillWatcher.js';

export interface RunDealOptions {
  pollIntervalMs?: number;
  /**
   * How many CONSECUTIVE ticks a cancel/divergence anomaly must repeat
   * before actually halting. fetchPosition/fetchOpenOrders are two separate
   * REST calls, not one atomic snapshot — a one-tick disagreement between
   * them must not be a spontaneous halt for a 24/7 bot (PLAN.md).
   */
  haltConfirmationTicks?: number;
  /**
   * MVP §13.5: optional WS wake-up trigger. Purely a latency optimization —
   * omitted (as in every test that doesn't set it), the loop behaves exactly
   * as before, plain `sleep(pollIntervalMs)`. Never a source of truth: the
   * following tick's reconcileTick always re-derives state from REST
   * regardless of what woke it up.
   */
  fillWatcher?: FillWatcher;
}

export interface RunDealParams extends OrchestratorContext {
  dealId: string;
  /** Price captured at the moment of entry (Slice 8: when filters align). */
  entryPrice: number;
  options?: RunDealOptions;
}

export type RunDealResult =
  | { outcome: 'closed'; closeReason: DealCloseReason }
  | { outcome: 'runaway' }
  | { outcome: 'halted'; reason: string };

const CONTRACTS_EPS = 1e-9;

interface HaltGateState {
  lastSignature: string | null;
  streak: number;
}

interface TickContext extends OrchestratorContext {
  dealId: string;
  gate: HaltGateState;
  haltConfirmationTicks: number;
  /** Resolved once in runDealLoop (ctx.logger ?? noop) — always present here, unlike on OrchestratorContext. */
  logger: Logger;
  notifier: Notifier;
}

/** MVP §13.6: notifications are a best-effort side channel — a failed send must never block the state machine. */
async function notifySafely(logger: Logger, notifier: Notifier, message: string): Promise<void> {
  try {
    await notifier.notify(message);
  } catch (error) {
    logger.warn({ error }, 'notifySafely: notifier.notify failed');
  }
}

function contractsImpliedByDb(
  gridRows: readonly GridOrderRow[],
  exitRows: readonly ExitOrderRow[],
): number {
  const grid = gridRows.reduce((sum, row) => {
    if (row.status === 'filled') return sum + row.size;
    if (row.status === 'placed') return sum + row.filledSize;
    return sum;
  }, 0);
  const exit = exitRows.reduce((sum, row) => {
    if (row.status === 'filled') return sum + row.amount;
    if (row.status === 'placed') return sum + row.filledSize;
    return sum;
  }, 0);
  return grid - exit;
}

function haltSignature(events: readonly ReconcileEvent[]): string | null {
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
function advanceHaltGate(
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

async function haltDeal(ctx: TickContext, reason: string): Promise<RunDealResult> {
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

function warnIfLiquidationEntersGrid(
  logger: Logger,
  gridRows: readonly GridOrderRow[],
  liquidationPrice: number | null,
  dealId: string,
): void {
  if (liquidationPrice === null) return;
  const deepest = gridRows
    .filter((row) => row.status !== 'cancelled')
    .reduce((min, row) => Math.min(min, row.price), Infinity);
  if (Number.isFinite(deepest) && liquidationPrice >= deepest) {
    // MVP §8: informational only.
    logger.warn(
      { dealId, liquidationPrice, deepestRungPrice: deepest },
      "liquidation price has reached the grid's deepest resting rung",
    );
  }
}

async function gridPlacedTick(ctx: TickContext): Promise<'continue' | RunDealResult> {
  const { adapter, db, config, now, dealId, gate, haltConfirmationTicks, logger, notifier } = ctx;

  const [openOrders, position] = await Promise.all([
    adapter.fetchOpenOrders(config.symbol),
    adapter.fetchPosition(config.symbol),
  ]);
  const gridRows = getGridOrdersByDeal(db, dealId);
  const placedGrid = gridRows.filter((row) => row.status === 'placed');
  const previousContracts = contractsImpliedByDb(gridRows, []);

  const events = reconcileTick({
    gridOrders: placedGrid.map((row) => ({
      clientOrderId: row.clientOrderId,
      rungIndex: row.rungIndex,
      price: row.price,
      size: row.size,
      filledSize: row.filledSize,
    })),
    exitOrders: [],
    previousContracts,
    openOrders,
    position,
  });

  const signature = haltSignature(events);
  if (advanceHaltGate(gate, signature, haltConfirmationTicks)) {
    return haltDeal(ctx, signature ?? 'unknown anomaly');
  }

  const partials = events.filter((event) => event.kind === 'partial_fill');
  const rungFilled = events.find((event) => event.kind === 'rung_filled');

  if (rungFilled) {
    if (position.entryPrice === null) {
      throw new Error(
        'runDeal: exchange reports no open position right after a detected first fill',
      );
    }
    const avgEntry = position.entryPrice;
    const intent = decide({ config, filledRungsCount: 1, avgEntry, event: 'rung_filled' });
    if (intent.type !== 'open') {
      throw new Error(
        `runDeal: expected decide() to return 'open' on the first fill, got '${intent.type}'`,
      );
    }

    const tpClientOrderId = `${dealId}-tp-0`;
    await adapter.createOrder({
      symbol: config.symbol,
      side: 'sell',
      type: 'limit',
      amount: position.contracts,
      price: intent.takeProfitPrice,
      clientOrderId: tpClientOrderId,
      reduceOnly: true,
    });
    let slClientOrderId: string | null = null;
    if (intent.stopLossPrice !== null) {
      slClientOrderId = `${dealId}-sl-0`;
      await adapter.createOrder({
        symbol: config.symbol,
        side: 'sell',
        type: 'limit',
        amount: position.contracts,
        price: intent.stopLossPrice,
        clientOrderId: slClientOrderId,
        reduceOnly: true,
      });
    }

    const gridRowsAfterFill = gridRows.map((row) =>
      row.clientOrderId === rungFilled.clientOrderId ? { ...row, status: 'filled' as const } : row,
    );
    const deliverMutations = await deliverNextRungs({
      adapter,
      config,
      gridOrders: gridRowsAfterFill,
      now,
    });

    runInTransaction(db, () => {
      for (const partial of partials) {
        updateGridOrderStatus(db, partial.clientOrderId, {
          status: 'placed',
          filledSize: partial.filledSize,
        });
      }
      updateGridOrderStatus(db, rungFilled.clientOrderId, {
        status: 'filled',
        filledAt: now(),
        fillPrice: rungFilled.fillPrice,
      });
      for (const mutation of deliverMutations) {
        updateGridOrderStatus(db, mutation.clientOrderId, mutation.patch);
      }
      insertExitOrder(db, {
        dealId,
        type: 'tp',
        clientOrderId: tpClientOrderId,
        price: intent.takeProfitPrice,
        amount: position.contracts,
        createdAt: now(),
      });
      if (slClientOrderId !== null && intent.stopLossPrice !== null) {
        insertExitOrder(db, {
          dealId,
          type: 'sl',
          clientOrderId: slClientOrderId,
          price: intent.stopLossPrice,
          amount: position.contracts,
          createdAt: now(),
        });
      }
      updateDeal(db, dealId, { status: 'ACTIVE', filledRungsCount: 1 });
    });

    // MVP §13.6: "угода відкрилась" — the first fill is what actually opens the deal.
    logger.info(
      { dealId, avgEntry, takeProfitPrice: intent.takeProfitPrice },
      'deal opened (first fill)',
    );
    await notifySafely(
      logger,
      notifier,
      `Deal ${dealId} opened: avgEntry=${String(avgEntry)}, TP=${String(intent.takeProfitPrice)}`,
    );

    return 'continue';
  }

  if (partials.length > 0) {
    runInTransaction(db, () => {
      for (const partial of partials) {
        updateGridOrderStatus(db, partial.clientOrderId, {
          status: 'placed',
          filledSize: partial.filledSize,
        });
      }
    });
  }

  const deal = getDeal(db, dealId);
  if (!deal || deal.pEntry === null) {
    throw new Error(`runDeal: GRID_PLACED deal ${dealId} is missing pEntry`);
  }

  // Runaway-cancel is only valid before ANY fill — including a PARTIAL one.
  // A partial fill this tick already means the position is no longer flat
  // (contracts > 0), so cancelling the rest of the grid here would abandon
  // that partial position untracked (no TP/SL, no further reconciliation).
  // Same race the full-fill case already guards against: reconciliation
  // output always takes precedence over runaway, whether the fill was full
  // or partial.
  if (position.contracts <= CONTRACTS_EPS) {
    const candles = await adapter.fetchOHLCV(config.symbol, '1m', undefined, 1);
    const currentPrice = candles.at(-1)?.close;
    if (currentPrice === undefined) {
      throw new Error(
        'runDeal: no candle available to read the current price for the runaway check',
      );
    }

    if (shouldCancelForRunaway(deal.pEntry, currentPrice, config.grid.runaway_cancel_pct)) {
      await adapter.cancelAll(config.symbol);
      const cancelledAt = now();
      runInTransaction(db, () => {
        for (const row of gridRows) {
          if (row.status === 'placed' || row.status === 'pending') {
            updateGridOrderStatus(db, row.clientOrderId, { status: 'cancelled', cancelledAt });
          }
        }
        updateDeal(db, dealId, {
          status: 'SETTLING',
          closeReason: 'runaway',
          closedAt: cancelledAt,
        });
      });
      return { outcome: 'runaway' };
    }
  }

  return 'continue';
}

async function activeTick(ctx: TickContext): Promise<'continue' | RunDealResult> {
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

  warnIfLiquidationEntersGrid(logger, gridRows, position.liquidationPrice, dealId);

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
      logger.warn({ dealId, error }, 'computeNet failed, closing with netProfit: null');
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

    logger.info({ dealId, closeReason, netProfit }, 'deal closed');
    await notifySafely(
      logger,
      notifier,
      `Deal ${dealId} closed (${closeReason}), NET=${netProfit === null ? 'unknown' : String(netProfit)}`,
    );
    if (haltAfterLoss) {
      logger.error({ dealId }, 'deal HALTED after a loss (halt_after_loss)');
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
      { dealId, filledRungsCount: newFilledRungsCount, avgEntry: position.entryPrice },
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

/**
 * Races the WS wake-up signal against the plain poll interval. A failed
 * watch (dropped connection, transient error) must not win the race — it
 * degrades to "this arm never resolves," so the sleep arm always wins
 * instead, falling back to the ordinary poll cadence for this round. Only
 * logs on a working<->broken TRANSITION, not every failed round, so a
 * long WS outage doesn't spam the log at poll-interval frequency.
 */
function watchOrNeverThisRound(
  fillWatcher: FillWatcher,
  symbol: string,
  logger: Logger,
  wsHealth: { healthy: boolean },
): Promise<void> {
  return fillWatcher.next(symbol).then(
    () => {
      if (!wsHealth.healthy) {
        logger.info('WS fill-watch recovered');
        wsHealth.healthy = true;
      }
    },
    (error: unknown) => {
      if (wsHealth.healthy) {
        logger.warn({ error }, 'WS fill-watch failed, falling back to poll cadence');
        wsHealth.healthy = false;
      }
      return new Promise<void>(() => {
        // Never resolves this round — the sleep race arm wins instead.
      });
    },
  );
}

/**
 * Drives an already-GRID_PLACED-or-later deal forward one tick at a time
 * until it closes, runaway-cancels, or halts. Shared by runDeal (fresh
 * start) and recoverDeal (resumed after a restart) — both just need to
 * arrange for the deal row to already exist in the right status; this loop
 * doesn't care how it got there.
 */
export async function runDealLoop(
  ctx: OrchestratorContext & { dealId: string; options?: RunDealOptions },
): Promise<RunDealResult> {
  const pollIntervalMs = ctx.options?.pollIntervalMs ?? 500;
  const haltConfirmationTicks = ctx.options?.haltConfirmationTicks ?? 2;
  const fillWatcher = ctx.options?.fillWatcher;
  const gate: HaltGateState = { lastSignature: null, streak: 0 };
  const logger = ctx.logger ?? createNoopLogger();
  const notifier = ctx.notifier ?? createNoopNotifier();
  const wsHealth = { healthy: true };

  for (;;) {
    const deal = getDeal(ctx.db, ctx.dealId);
    if (!deal) throw new Error(`runDeal: deal ${ctx.dealId} not found`);

    const tickCtx: TickContext = { ...ctx, gate, haltConfirmationTicks, logger, notifier };

    let result: 'continue' | RunDealResult;
    if (deal.status === 'GRID_PLACED') {
      result = await gridPlacedTick(tickCtx);
    } else if (deal.status === 'ACTIVE') {
      result = await activeTick(tickCtx);
    } else {
      throw new Error(`runDeal: cannot drive deal ${ctx.dealId} in status '${deal.status}'`);
    }

    if (result !== 'continue') return result;

    if (fillWatcher) {
      await Promise.race([
        sleep(pollIntervalMs),
        watchOrNeverThisRound(fillWatcher, ctx.config.symbol, logger, wsHealth),
      ]);
    } else {
      await sleep(pollIntervalMs);
    }
  }
}

/**
 * MVP §5 (GRID_PLACED -> ...): computes the grid once, persists it and
 * places the first `partial_placement` rungs, then hands off to
 * runDealLoop. Replaces Slice 7's openDeal/closeDeal/runThinSlice — those
 * only ever handled exactly one entry fill then exactly one exit fill; this
 * reacts to whatever fills/cancels/reprices happen next, in any order.
 */
export async function runDeal(params: RunDealParams): Promise<RunDealResult> {
  const { adapter, db, now, dealId, entryPrice, options, logger, notifier } = params;
  // MVP §7: this deal's budget is the compounded deposit from the reinvest
  // chain (resolveDeposit.ts), not always the static config value — shadows
  // `config` for the rest of this function so every downstream read
  // (projectGrid, the config_snapshot, runDealLoop) sees the resolved
  // number consistently, not just the initial `deal` row.
  const config = { ...params.config, deposit_usdt: resolveDepositUsdt(db, params.config) };

  insertDeal(db, {
    id: dealId,
    status: 'WAITING_SIGNAL',
    direction: config.direction,
    depositUsdt: config.deposit_usdt,
    openedAt: now(),
  });

  const plan = projectGrid(config, entryPrice, dealId);
  const market = await adapter.getMarketInfo(config.symbol);
  const ready = makeGridExchangeReady(plan, market);
  if (!ready.ok) {
    throw new Error(`runDeal: grid not exchange-ready: ${ready.reason}`);
  }

  placeGrid(db, {
    dealId,
    pEntry: entryPrice,
    rungs: ready.rungs.map((rung) => ({
      rungIndex: rung.index,
      price: rung.price,
      size: rung.size,
      clientOrderId: rung.clientOrderId,
    })),
    config,
    at: now(),
  });

  await adapter.setupSymbol(config.symbol, config.leverage, config.margin_mode);

  const initialGridOrders = getGridOrdersByDeal(db, dealId);
  const initialDelivery = await deliverNextRungs({
    adapter,
    config,
    gridOrders: initialGridOrders,
    now,
  });
  if (initialDelivery.length > 0) {
    runInTransaction(db, () => {
      for (const mutation of initialDelivery) {
        updateGridOrderStatus(db, mutation.clientOrderId, mutation.patch);
      }
    });
  }

  return runDealLoop({
    adapter,
    db,
    config,
    now,
    dealId,
    ...(options !== undefined ? { options } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(notifier !== undefined ? { notifier } : {}),
  });
}
