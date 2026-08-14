import { insertDeal, updateDeal } from '../storage/dealRepository.js';
import { insertGridOrders, updateGridOrderStatus } from '../storage/gridOrderRepository.js';
import { insertExitOrder } from '../storage/exitOrderRepository.js';
import { insertConfigSnapshot } from '../storage/configSnapshotRepository.js';
import { runInTransaction } from '../storage/transaction.js';
import { decide } from '../strategy/decide.js';
import { runDealLoop } from './runDeal.js';
import type { RunDealOptions, RunDealResult } from './runDeal.js';
import type { OrchestratorContext } from './types.js';

export interface AdoptExistingPositionParams extends OrchestratorContext {
  dealId: string;
  options?: RunDealOptions;
}

/**
 * MVP §9: if include_existing_position is true and the exchange already has
 * an open position on config.symbol at startup, adopt it into a fresh deal
 * instead of waiting for entry_filters — avoids opening a second, colliding
 * position on top of a leftover one. Default false; MVP starts clean.
 *
 * Minimal support only: no reconstructed grid, no safety-order averaging.
 * projectGrid needs one real P_entry (the moment filters aligned) and a
 * clean deposit×leverage budget to distribute — neither exists for a
 * position this bot didn't open. Guessing them (fake P_entry from the
 * current avg, fake "which rung is this") would inject invented history
 * into an otherwise config-driven system. So this only seeds ONE synthetic
 * 'filled' grid_order row (size = real position.contracts, price/fillPrice
 * = real avgEntry — never sent to the exchange, purely the accounting
 * baseline reconcile.ts's contractsImpliedByDb needs) and places TP (and
 * SL, if configured) against the real avg. No further rungs ever exist to
 * deliver, so deliverNextRungs naturally never fires for this deal.
 *
 * Returns null when there's nothing to adopt (flag off, or flat) — the
 * caller falls through to the normal watchForEntry/runDeal path.
 */
export async function adoptExistingPosition(
  params: AdoptExistingPositionParams,
): Promise<RunDealResult | null> {
  const { adapter, db, config, now, dealId, options } = params;
  if (!config.include_existing_position) return null;

  const position = await adapter.fetchPosition(config.symbol);
  if (position.contracts <= 0 || position.entryPrice === null) return null;
  const avgEntry = position.entryPrice;

  const intent = decide({ config, filledRungsCount: 1, avgEntry, event: 'rung_filled' });
  if (intent.type !== 'open') {
    throw new Error(
      `adoptExistingPosition: expected decide() to return 'open', got '${intent.type}'`,
    );
  }

  insertDeal(db, {
    id: dealId,
    status: 'WAITING_SIGNAL',
    direction: config.direction,
    depositUsdt: config.deposit_usdt,
    openedAt: now(),
  });

  const syntheticClientOrderId = `${dealId}-adopted`;
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

  runInTransaction(db, () => {
    insertGridOrders(
      db,
      dealId,
      [
        {
          rungIndex: 1,
          price: avgEntry,
          size: position.contracts,
          clientOrderId: syntheticClientOrderId,
        },
      ],
      now(),
    );
    updateGridOrderStatus(db, syntheticClientOrderId, {
      status: 'filled',
      filledAt: now(),
      fillPrice: avgEntry,
    });
    insertConfigSnapshot(db, dealId, config, now());
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
    updateDeal(db, dealId, { status: 'ACTIVE', pEntry: avgEntry, filledRungsCount: 1 });
  });

  return runDealLoop({
    adapter,
    db,
    config,
    now,
    dealId,
    ...(options !== undefined ? { options } : {}),
  });
}
