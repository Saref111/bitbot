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
import { sleep } from '../util/time.js';
import type { GridOrderRow, ExitOrderRow, DealCloseReason } from '../storage/types.js';
import type { ReconcileEvent } from './reconcileTypes.js';
import type { ExitTargetMutation } from './exitTargets.js';
import type { OrchestratorContext } from './types.js';

export interface RunDealOptions {
  pollIntervalMs?: number;
  /**
   * How many CONSECUTIVE ticks a cancel/divergence anomaly must repeat
   * before actually halting. fetchPosition/fetchOpenOrders are two separate
   * REST calls, not one atomic snapshot — a one-tick disagreement between
   * them must not be a spontaneous halt for a 24/7 bot (PLAN.md).
   */
  haltConfirmationTicks?: number;
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
  const { adapter, db, config, dealId, now } = ctx;
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
  gridRows: readonly GridOrderRow[],
  liquidationPrice: number | null,
  dealId: string,
): void {
  if (liquidationPrice === null) return;
  const deepest = gridRows
    .filter((row) => row.status !== 'cancelled')
    .reduce((min, row) => Math.min(min, row.price), Infinity);
  if (Number.isFinite(deepest) && liquidationPrice >= deepest) {
    // MVP §8: informational only — Slice 11 replaces this with pino + Telegram.
    console.warn(
      `runDeal: deal ${dealId} — liquidation price ${String(liquidationPrice)} has reached the grid's deepest resting rung (${String(deepest)})`,
    );
  }
}

async function gridPlacedTick(ctx: TickContext): Promise<'continue' | RunDealResult> {
  const { adapter, db, config, now, dealId, gate, haltConfirmationTicks } = ctx;

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
  const { adapter, db, config, now, dealId, gate, haltConfirmationTicks } = ctx;

  const [openOrders, position] = await Promise.all([
    adapter.fetchOpenOrders(config.symbol),
    adapter.fetchPosition(config.symbol),
  ]);
  const gridRows = getGridOrdersByDeal(db, dealId);
  const exitRows = getExitOrdersByDeal(db, dealId);
  const placedGrid = gridRows.filter((row) => row.status === 'placed');
  const placedExit = exitRows.filter((row) => row.status === 'placed');
  const previousContracts = contractsImpliedByDb(gridRows, exitRows);

  warnIfLiquidationEntersGrid(gridRows, position.liquidationPrice, dealId);

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
      netProfit = (await computeNet(adapter, config.symbol, deal.openedAt)).netProfit;
    } catch (error) {
      console.warn(
        `runDeal: computeNet failed for deal ${dealId}, closing with netProfit: null — ${String(error)}`,
      );
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

  return 'continue';
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
  const gate: HaltGateState = { lastSignature: null, streak: 0 };

  for (;;) {
    const deal = getDeal(ctx.db, ctx.dealId);
    if (!deal) throw new Error(`runDeal: deal ${ctx.dealId} not found`);

    const tickCtx: TickContext = { ...ctx, gate, haltConfirmationTicks };

    let result: 'continue' | RunDealResult;
    if (deal.status === 'GRID_PLACED') {
      result = await gridPlacedTick(tickCtx);
    } else if (deal.status === 'ACTIVE') {
      result = await activeTick(tickCtx);
    } else {
      throw new Error(`runDeal: cannot drive deal ${ctx.dealId} in status '${deal.status}'`);
    }

    if (result !== 'continue') return result;
    await sleep(pollIntervalMs);
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
  const { adapter, db, now, dealId, entryPrice, options } = params;
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
  });
}
