import { watchForEntry } from '../feed/liveFeed.js';
import { openDeal } from './openDeal.js';
import type { OrchestratorContext } from './types.js';
import type { OpenDealResult } from './openDeal.js';

export interface WaitAndOpenDealParams extends OrchestratorContext {
  dealId: string;
  warmupCandles?: number;
  feedPollIntervalMs?: number;
  fillPollIntervalMs?: number;
  fillTimeoutMs?: number;
}

/**
 * MVP §5 (WAITING_SIGNAL -> GRID_PLACED): waits for entry_filters to align
 * (Slice 8's watchForEntry) and opens the deal at exactly that price (Slice
 * 7's openDeal). This is the actual "bot enters a deal when filters align"
 * behavior PLAN.md's Slice 8 Done criterion describes — watchForEntry alone
 * only computes the signal, it doesn't act on it.
 */
export async function waitAndOpenDeal(params: WaitAndOpenDealParams): Promise<OpenDealResult> {
  const signal = await watchForEntry({
    adapter: params.adapter,
    config: params.config,
    now: params.now,
    ...(params.warmupCandles !== undefined ? { warmupCandles: params.warmupCandles } : {}),
    ...(params.feedPollIntervalMs !== undefined
      ? { pollIntervalMs: params.feedPollIntervalMs }
      : {}),
  });

  return openDeal({
    adapter: params.adapter,
    db: params.db,
    config: params.config,
    now: params.now,
    dealId: params.dealId,
    entryPrice: signal.price,
    ...(params.fillPollIntervalMs !== undefined
      ? { pollIntervalMs: params.fillPollIntervalMs }
      : {}),
    ...(params.fillTimeoutMs !== undefined ? { fillTimeoutMs: params.fillTimeoutMs } : {}),
  });
}
