import { getMostRecentClosedDeal } from '../storage/index.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config/index.js';

/**
 * MVP §7: the reinvest chain lives in deal.deposit_usdt/net_profit, not a
 * separate state table. Only a `SETTLING` deal is trusted as a chain base —
 * a `HALTED` one breaks the chain deliberately: its
 * deposit_usdt is a MODEL of what was allocated, not a fact about the
 * account, and after a liquidation specifically the two can diverge hard
 * (real balance collapses; the modeled deposit doesn't know that). HALTED
 * already means "stop and wait for a human" — the operator reconciling
 * config.deposit_usdt against the real wallet balance before resuming is
 * that same human step, not something to guess here with a fetchBalance
 * call this adapter doesn't have.
 */
export function resolveDepositUsdt(db: DatabaseSync, config: Config): number {
  const lastDeal = getMostRecentClosedDeal(db);
  if (!lastDeal || lastDeal.status !== 'SETTLING') {
    return config.deposit_usdt;
  }
  const reinvestAmount =
    lastDeal.netProfit !== null && lastDeal.netProfit > 0
      ? (config.reinvest_pct / 100) * lastDeal.netProfit
      : 0;
  return lastDeal.depositUsdt + reinvestAmount;
}
