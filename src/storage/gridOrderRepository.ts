import type { DatabaseSync } from 'node:sqlite';
import type { GridOrderRow, GridOrderStatus } from './types.js';

export interface NewGridOrder {
  rungIndex: number;
  price: number;
  size: number;
  clientOrderId: string;
}

export interface GridOrderPatch {
  status: GridOrderStatus;
  placedAt?: number;
  filledAt?: number;
  cancelledAt?: number;
  fillPrice?: number;
}

function mapRow(row: Record<string, unknown>): GridOrderRow {
  return {
    id: row.id as number,
    dealId: row.deal_id as string,
    rungIndex: row.rung_index as number,
    price: row.price as number,
    size: row.size as number,
    clientOrderId: row.client_order_id as string,
    status: row.status as GridOrderStatus,
    createdAt: row.created_at as number,
    placedAt: row.placed_at as number | null,
    filledAt: row.filled_at as number | null,
    cancelledAt: row.cancelled_at as number | null,
    fillPrice: row.fill_price as number | null,
  };
}

/**
 * MVP §5: the whole grid is computed once and stored as 'pending' upfront,
 * delivered incrementally later. This loop is plain autocommit — it is NOT
 * atomic on its own. Callers that combine this with other writes into one
 * all-or-nothing unit (e.g. placeGrid.ts) must wrap the whole composition in
 * runInTransaction themselves; this function must not start its own
 * transaction, or nesting it inside a caller's transaction would error.
 */
export function insertGridOrders(
  db: DatabaseSync,
  dealId: string,
  rungs: readonly NewGridOrder[],
  createdAt: number,
): void {
  const insert = db.prepare(
    `INSERT INTO grid_order (deal_id, rung_index, price, size, client_order_id, status, created_at)
     VALUES (@dealId, @rungIndex, @price, @size, @clientOrderId, 'pending', @createdAt)`,
  );
  for (const rung of rungs) {
    insert.run({ dealId, createdAt, ...rung });
  }
}

export function updateGridOrderStatus(
  db: DatabaseSync,
  clientOrderId: string,
  patch: GridOrderPatch,
): void {
  db.prepare(
    `UPDATE grid_order
     SET status = @status,
         placed_at = COALESCE(@placedAt, placed_at),
         filled_at = COALESCE(@filledAt, filled_at),
         cancelled_at = COALESCE(@cancelledAt, cancelled_at),
         fill_price = COALESCE(@fillPrice, fill_price)
     WHERE client_order_id = @clientOrderId`,
  ).run({
    clientOrderId,
    status: patch.status,
    placedAt: patch.placedAt ?? null,
    filledAt: patch.filledAt ?? null,
    cancelledAt: patch.cancelledAt ?? null,
    fillPrice: patch.fillPrice ?? null,
  });
}

export function getGridOrdersByDeal(db: DatabaseSync, dealId: string): GridOrderRow[] {
  const rows = db
    .prepare('SELECT * FROM grid_order WHERE deal_id = @dealId ORDER BY rung_index ASC')
    .all({ dealId });
  return rows.map(mapRow);
}
