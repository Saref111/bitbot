import { insertDeal, updateDeal } from '../storage/dealRepository.js';
import { updateGridOrderStatus } from '../storage/gridOrderRepository.js';
import { insertExitOrder } from '../storage/exitOrderRepository.js';
import { placeGrid } from '../storage/placeGrid.js';
import { projectGrid } from '../grid/projectGrid.js';
import { makeGridExchangeReady } from '../exchange/gridReady.js';
import { decide } from '../strategy/decide.js';
import { pollUntil } from './pollUntil.js';
import type { OrchestratorContext } from './types.js';
import type { ReadyRung } from '../exchange/gridReady.js';

export interface OpenDealParams extends OrchestratorContext {
  dealId: string;
  /** Price captured at the moment of entry (Slice 8: when filters align); this thin slice takes it as a plain input. */
  entryPrice: number;
  pollIntervalMs?: number;
  fillTimeoutMs?: number;
}

export interface OpenDealResult {
  dealId: string;
  avgEntry: number;
  takeProfitPrice: number;
  exitClientOrderId: string;
  stopLossClientOrderId: string | null;
}

/**
 * MVP §5 (GRID_PLACED -> ACTIVE): computes the whole grid once, persists it
 * atomically, places every rung (partial_placement: null — delivering fewer
 * than all of them is Slice 8/9), waits for the first fill, then places
 * TP/SL from the REAL avg entry the exchange reports (not the input
 * entryPrice, which for a marketable order can differ from the fill price).
 *
 * Slice 7 scope note: the grid-computation/persistence/placement portion
 * (through placing every rung) is the real GRID_PLACED logic and should
 * carry forward into Slice 8/9 largely as-is. The "wait for exactly one
 * fill via pollUntil" portion is narrow scaffolding — Slice 9's state
 * machine reacts to fill events as they arrive (any rung, in any order,
 * possibly several before the first decide() call) instead of blocking on
 * one specific poll loop, so that part will be rewritten, not reused.
 */
export async function openDeal(params: OpenDealParams): Promise<OpenDealResult> {
  const { adapter, db, config, now, dealId, entryPrice } = params;
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const fillTimeoutMs = params.fillTimeoutMs ?? 60_000;

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
    throw new Error(`openDeal: grid not exchange-ready: ${ready.reason}`);
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

  for (const rung of ready.rungs) {
    await adapter.createOrder({
      symbol: config.symbol,
      side: 'buy',
      type: 'limit',
      amount: rung.size,
      price: rung.price,
      clientOrderId: rung.clientOrderId,
    });
    updateGridOrderStatus(db, rung.clientOrderId, { status: 'placed', placedAt: now() });
  }

  const filledRung = await pollUntil<ReadyRung>(
    async () => {
      const openOrders = await adapter.fetchOpenOrders(config.symbol);
      const openClientOrderIds = new Set(openOrders.map((order) => order.clientOrderId));
      return ready.rungs.find((rung) => !openClientOrderIds.has(rung.clientOrderId)) ?? null;
    },
    { intervalMs: pollIntervalMs, timeoutMs: fillTimeoutMs },
  );

  const position = await adapter.fetchPosition(config.symbol);
  if (position.entryPrice === null) {
    throw new Error('openDeal: exchange reports no open position right after a detected fill');
  }
  const avgEntry = position.entryPrice;

  updateDeal(db, dealId, { status: 'ACTIVE', filledRungsCount: 1 });
  // Slice 9 TODO: fillPrice is recorded as the position's avg entry, which
  // only equals this rung's own fill price because it's the ONLY fill so
  // far. Once multiple rungs can fill (averaging), each grid_order needs
  // its own real fill price (e.g. from the order/trade the exchange
  // reports), not the blended position avg.
  updateGridOrderStatus(db, filledRung.clientOrderId, {
    status: 'filled',
    filledAt: now(),
    fillPrice: avgEntry,
  });

  const intent = decide({ config, filledRungsCount: 1, avgEntry, event: 'rung_filled' });
  if (intent.type !== 'open') {
    throw new Error(
      `openDeal: expected decide() to return 'open' on the first fill, got '${intent.type}'`,
    );
  }

  const exitClientOrderId = `${dealId}-tp`;
  await adapter.createOrder({
    symbol: config.symbol,
    side: 'sell',
    type: 'limit',
    amount: position.contracts,
    price: intent.takeProfitPrice,
    clientOrderId: exitClientOrderId,
    reduceOnly: true,
  });
  insertExitOrder(db, {
    dealId,
    type: 'tp',
    clientOrderId: exitClientOrderId,
    price: intent.takeProfitPrice,
    createdAt: now(),
  });

  let stopLossClientOrderId: string | null = null;
  if (intent.stopLossPrice !== null) {
    stopLossClientOrderId = `${dealId}-sl`;
    await adapter.createOrder({
      symbol: config.symbol,
      side: 'sell',
      type: 'limit',
      amount: position.contracts,
      price: intent.stopLossPrice,
      clientOrderId: stopLossClientOrderId,
      reduceOnly: true,
    });
    insertExitOrder(db, {
      dealId,
      type: 'sl',
      clientOrderId: stopLossClientOrderId,
      price: intent.stopLossPrice,
      createdAt: now(),
    });
  }

  return {
    dealId,
    avgEntry,
    takeProfitPrice: intent.takeProfitPrice,
    exitClientOrderId,
    stopLossClientOrderId,
  };
}
