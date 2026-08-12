import type { DatabaseSync } from 'node:sqlite';
import type { DealCloseReason, DealRow, DealStatus } from './types.js';

export interface NewDeal {
  id: string;
  status: DealStatus;
  direction: 'long' | 'short';
  depositUsdt: number;
  openedAt: number;
}

export interface DealPatch {
  status?: DealStatus;
  pEntry?: number;
  filledRungsCount?: number;
  depositUsdt?: number;
  closeReason?: DealCloseReason;
  closedAt?: number;
}

const PATCH_COLUMNS: Record<keyof DealPatch, string> = {
  status: 'status',
  pEntry: 'p_entry',
  filledRungsCount: 'filled_rungs_count',
  depositUsdt: 'deposit_usdt',
  closeReason: 'close_reason',
  closedAt: 'closed_at',
};

function mapRow(row: Record<string, unknown>): DealRow {
  return {
    id: row.id as string,
    status: row.status as DealStatus,
    direction: row.direction as 'long' | 'short',
    pEntry: row.p_entry as number | null,
    filledRungsCount: row.filled_rungs_count as number,
    depositUsdt: row.deposit_usdt as number,
    closeReason: row.close_reason as DealCloseReason | null,
    openedAt: row.opened_at as number,
    closedAt: row.closed_at as number | null,
  };
}

export function insertDeal(db: DatabaseSync, deal: NewDeal): void {
  db.prepare(
    `INSERT INTO deal (id, status, direction, p_entry, filled_rungs_count, deposit_usdt, close_reason, opened_at, closed_at)
     VALUES (@id, @status, @direction, NULL, 0, @depositUsdt, NULL, @openedAt, NULL)`,
  ).run({
    id: deal.id,
    status: deal.status,
    direction: deal.direction,
    depositUsdt: deal.depositUsdt,
    openedAt: deal.openedAt,
  });
}

export function updateDeal(db: DatabaseSync, dealId: string, patch: DealPatch): void {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  const setClause = entries
    .map(([key]) => `${PATCH_COLUMNS[key as keyof DealPatch]} = @${key}`)
    .join(', ');
  db.prepare(`UPDATE deal SET ${setClause} WHERE id = @dealId`).run({
    ...Object.fromEntries(entries),
    dealId,
  });
}

export function getDeal(db: DatabaseSync, dealId: string): DealRow | null {
  const row = db.prepare('SELECT * FROM deal WHERE id = @dealId').get({ dealId });
  return row ? mapRow(row) : null;
}
