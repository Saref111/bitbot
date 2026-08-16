import {
  getGridOrdersByDeal,
  getDeal,
  updateGridOrderStatus,
  insertExitOrder,
  updateDeal,
  runInTransaction,
} from '../storage/index.js';
import { decide } from '../strategy/index.js';
import { reconcileTick, contractsImpliedByDb } from './reconcile.js';
import { shouldCancelForRunaway } from './runaway.js';
import { deliverNextRungs } from './deliverRungs.js';
import { haltSignature, advanceHaltGate, haltDeal, notifySafely } from './haltGate.js';
import { EPS } from './constants.js';
import type { RunDealResult, TickContext } from './types.js';

export async function gridPlacedTick(ctx: TickContext): Promise<'continue' | RunDealResult> {
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
  if (position.contracts <= EPS) {
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
