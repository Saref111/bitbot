import type { DatabaseSync } from 'node:sqlite';
import type { DealCloseReason, DealPatch, DealRow, DealStatus, NewDeal } from './types.js';
import { PATCH_COLUMNS } from './constants.js';

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
    netProfit: row.net_profit as number | null,
  };
}

export function insertDeal(db: DatabaseSync, deal: NewDeal): void {
  db.prepare(
    `INSERT INTO deal (id, status, direction, p_entry, filled_rungs_count, deposit_usdt, close_reason, opened_at, closed_at, net_profit)
     VALUES (@id, @status, @direction, NULL, 0, @depositUsdt, NULL, @openedAt, NULL, NULL)`,
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

/** MVP §7 (reinvest chain): the most recently closed deal, any final status — resolveDeposit.ts decides which statuses it trusts. */
export function getMostRecentClosedDeal(db: DatabaseSync): DealRow | null {
  const row = db
    .prepare('SELECT * FROM deal WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1')
    .get();
  return row ? mapRow(row) : null;
}

/** MVP §5 (restart bullet): a deal not yet in a terminal state (closedAt still null) — main.ts hands this to recoverDeal on startup instead of starting a fresh one. */
export function getMostRecentOpenDeal(db: DatabaseSync): DealRow | null {
  const row = db
    .prepare('SELECT * FROM deal WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1')
    .get();
  return row ? mapRow(row) : null;
}
