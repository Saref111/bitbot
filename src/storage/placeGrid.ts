import type { DatabaseSync } from 'node:sqlite';
import { updateDeal } from './dealRepository.js';
import { insertGridOrders } from './gridOrderRepository.js';
import { insertConfigSnapshot } from './configSnapshotRepository.js';
import { runInTransaction } from './transaction.js';
import { PlaceGridParams } from './types.js';

/**
 * MVP §5 (GRID_PLACED): capturing P_entry, computing the whole grid, and
 * snapshotting the config all happen at the same instant a deal starts, and
 * must be all-or-nothing. A crash after writing 7 of 14 grid_order rows
 * would leave restoreDeal() reconstructing a deal that never actually
 * existed in that shape — this is the write-side half of surviving a crash;
 * restoreDeal.ts is the read-side half.
 */
export function placeGrid(db: DatabaseSync, params: PlaceGridParams): void {
  runInTransaction(db, () => {
    updateDeal(db, params.dealId, { status: 'GRID_PLACED', pEntry: params.pEntry });
    insertGridOrders(db, params.dealId, params.rungs, params.at);
    insertConfigSnapshot(db, params.dealId, params.config, params.at);
  });
}
