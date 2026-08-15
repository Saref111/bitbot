import { watchForEntry } from '../feed/liveFeed.js';
import { runDeal } from './runDeal.js';
import type { OrchestratorContext } from './types.js';
import type { RunDealResult } from './runDeal.js';

export interface WaitAndOpenDealParams extends OrchestratorContext {
  dealId: string;
  warmupCandles?: number;
  feedPollIntervalMs?: number;
  dealPollIntervalMs?: number;
  haltConfirmationTicks?: number;
}

/**
 * MVP §5 (WAITING_SIGNAL -> GRID_PLACED -> ...): waits for entry_filters to
 * align (Slice 8's watchForEntry) and drives the deal at exactly that price
 * (Slice 9's runDeal) all the way to its terminal outcome. This is the
 * actual "bot enters a deal when filters align" behavior PLAN.md's Slice 8
 * Done criterion describes — watchForEntry alone only computes the signal,
 * it doesn't act on it.
 */
export async function waitAndOpenDeal(params: WaitAndOpenDealParams): Promise<RunDealResult> {
  const signal = await watchForEntry({
    adapter: params.adapter,
    config: params.config,
    now: params.now,
    ...(params.warmupCandles !== undefined ? { warmupCandles: params.warmupCandles } : {}),
    ...(params.feedPollIntervalMs !== undefined
      ? { pollIntervalMs: params.feedPollIntervalMs }
      : {}),
  });

  return runDeal({
    adapter: params.adapter,
    db: params.db,
    config: params.config,
    now: params.now,
    dealId: params.dealId,
    entryPrice: signal.price,
    options: {
      ...(params.dealPollIntervalMs !== undefined
        ? { pollIntervalMs: params.dealPollIntervalMs }
        : {}),
      ...(params.haltConfirmationTicks !== undefined
        ? { haltConfirmationTicks: params.haltConfirmationTicks }
        : {}),
    },
    ...(params.logger !== undefined ? { logger: params.logger } : {}),
    ...(params.notifier !== undefined ? { notifier: params.notifier } : {}),
  });
}
