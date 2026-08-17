import {
  insertDeal,
  getDeal,
  getGridOrdersByDeal,
  updateGridOrderStatus,
  placeGrid,
  runInTransaction,
} from '../storage/index.js';
import { projectGrid } from '../grid/index.js';
import { makeGridExchangeReady } from '../exchange/index.js';
import { gridPlacedTick } from './gridPlacedTick.js';
import { activeTick } from './activeTick.js';
import { deliverNextRungs } from './deliverRungs.js';
import { resolveDepositUsdt } from './resolveDeposit.js';
import { createNoopLogger } from '../logging/index.js';
import { createNoopNotifier } from '../notify/index.js';
import { sleep, waitForAbort } from '../util/index.js';
import type { Logger } from '../logging/index.js';
import type { FillWatcher } from '../exchange/index.js';
import type {
  HaltGateState,
  OrchestratorContext,
  RunDealOptions,
  RunDealParams,
  RunDealResult,
  TickContext,
} from './types.js';

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
  const signal = ctx.options?.signal;
  const gate: HaltGateState = { lastSignature: null, streak: 0 };
  const logger = ctx.logger ?? createNoopLogger();
  const notifier = ctx.notifier ?? createNoopNotifier();
  const wsHealth = { healthy: true };

  for (;;) {
    // Checked at the top, before any exchange call this iteration would
    // make — an in-flight tick always finishes; shutdown only ever skips
    // STARTING the next one.
    if (signal?.aborted) return { outcome: 'shutdown' };

    const deal = getDeal(ctx.db, ctx.dealId);
    if (!deal) throw new Error(`runDeal: deal ${ctx.dealId} not found`);

    const tickCtx: TickContext = { ...ctx, gate, haltConfirmationTicks, logger, notifier };

    // Not a full exhaustive switch+assertNever: this loop deliberately only
    // DRIVES 2 of the 5 statuses (the other 3 are a caller error, not a
    // state this function is meant to handle).
    let result: 'continue' | RunDealResult;
    switch (deal.status) {
      case 'GRID_PLACED':
        result = await gridPlacedTick(tickCtx);
        break;
      case 'ACTIVE':
        result = await activeTick(tickCtx);
        break;
      default:
        throw new Error(`runDeal: cannot drive deal ${ctx.dealId} in status '${deal.status}'`);
    }

    if (result !== 'continue') return result;

    // Races whichever wake-up arms are actually in play this run — plain
    // interval always included, WS fast-path and shutdown signal only when
    // the caller supplied them (every existing test that supplies neither
    // behaves exactly as before, plain sleep(pollIntervalMs)).
    const waitArms: Promise<void>[] = [sleep(pollIntervalMs)];
    if (fillWatcher) {
      waitArms.push(watchOrNeverThisRound(fillWatcher, ctx.config.symbol, logger, wsHealth));
    }
    if (signal) {
      waitArms.push(waitForAbort(signal));
    }
    await Promise.race(waitArms);
  }
}

/**
 * MVP §5 (GRID_PLACED -> ...): computes the grid once, persists it and
 * places the first `partial_placement` rungs, then hands off to
 * runDealLoop, which reacts to whatever fills/cancels/reprices happen next,
 * in any order (not just one entry fill followed by one exit fill).
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
