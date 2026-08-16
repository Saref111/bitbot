import { watchForEntry } from '../feed/index.js';
import { runDeal } from './runDeal.js';
import type { RunDealResult, WaitAndOpenDealParams } from './types.js';

/**
 * MVP §5 (WAITING_SIGNAL -> GRID_PLACED -> ...): waits for entry_filters to
 * align (watchForEntry) and drives the deal at exactly that price (runDeal)
 * all the way to its terminal outcome — watchForEntry alone only computes
 * the signal, it doesn't act on it.
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
