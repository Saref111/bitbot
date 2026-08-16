import type { DatabaseSync } from 'node:sqlite';
import { getDeal } from './dealRepository.js';
import { getGridOrdersByDeal } from './gridOrderRepository.js';
import { getExitOrdersByDeal } from './exitOrderRepository.js';
import { getConfigSnapshot } from './configSnapshotRepository.js';
import type { RestoredDeal } from './types.js';

/**
 * MVP §5 (restart bullet): reconstructs a deal's full stored state from
 * SQLite by dealId. This is the storage-layer half of restart recovery —
 * reconciling it against the live exchange (positions/open orders) is the
 * orchestrator's concern, not this function's.
 */
export function restoreDeal(db: DatabaseSync, dealId: string): RestoredDeal | null {
  const deal = getDeal(db, dealId);
  if (!deal) return null;

  return {
    deal,
    gridOrders: getGridOrdersByDeal(db, dealId),
    exitOrders: getExitOrdersByDeal(db, dealId),
    config: getConfigSnapshot(db, dealId),
  };
}
