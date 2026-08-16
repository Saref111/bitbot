import { DealPatch } from './types.js';

export const PATCH_COLUMNS: Record<keyof DealPatch, string> = {
  status: 'status',
  pEntry: 'p_entry',
  filledRungsCount: 'filled_rungs_count',
  depositUsdt: 'deposit_usdt',
  closeReason: 'close_reason',
  closedAt: 'closed_at',
  netProfit: 'net_profit',
};
