import type { DatabaseSync } from 'node:sqlite';
import type { ExitOrderRow, ExitOrderStatus, ExitOrderType } from './types.js';

export interface NewExitOrder {
  dealId: string;
  type: ExitOrderType;
  clientOrderId: string;
  price: number;
  amount: number;
  createdAt: number;
}

export interface ExitOrderPatch {
  status: ExitOrderStatus;
  filledAt?: number;
  cancelledAt?: number;
  filledSize?: number;
}

function mapRow(row: Record<string, unknown>): ExitOrderRow {
  return {
    id: row.id as number,
    dealId: row.deal_id as string,
    type: row.type as ExitOrderType,
    clientOrderId: row.client_order_id as string,
    price: row.price as number,
    amount: row.amount as number,
    status: row.status as ExitOrderStatus,
    createdAt: row.created_at as number,
    filledAt: row.filled_at as number | null,
    cancelledAt: row.cancelled_at as number | null,
    filledSize: row.filled_size as number,
  };
}

/** MVP §6: exit orders (TP/SL) are resting reduceOnly orders, placed as soon as their target is known. */
export function insertExitOrder(db: DatabaseSync, exitOrder: NewExitOrder): void {
  db.prepare(
    `INSERT INTO exit_order (deal_id, type, client_order_id, price, amount, status, created_at)
     VALUES (@dealId, @type, @clientOrderId, @price, @amount, 'placed', @createdAt)`,
  ).run({ ...exitOrder });
}

export function updateExitOrderStatus(
  db: DatabaseSync,
  clientOrderId: string,
  patch: ExitOrderPatch,
): void {
  db.prepare(
    `UPDATE exit_order
     SET status = @status,
         filled_at = COALESCE(@filledAt, filled_at),
         cancelled_at = COALESCE(@cancelledAt, cancelled_at),
         filled_size = COALESCE(@filledSize, filled_size)
     WHERE client_order_id = @clientOrderId`,
  ).run({
    clientOrderId,
    status: patch.status,
    filledAt: patch.filledAt ?? null,
    cancelledAt: patch.cancelledAt ?? null,
    filledSize: patch.filledSize ?? null,
  });
}

export function getExitOrdersByDeal(db: DatabaseSync, dealId: string): ExitOrderRow[] {
  const rows = db
    .prepare('SELECT * FROM exit_order WHERE deal_id = @dealId ORDER BY id ASC')
    .all({ dealId });
  return rows.map(mapRow);
}
