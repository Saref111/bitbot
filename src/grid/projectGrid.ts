import type { Config } from '../config/types.js';
import type { GridPlan, GridRung } from './types.js';

/**
 * MVP §4: grid prices follow a power-law curve (NOT linear, NOT exponential):
 * x = (i-1)/(N-1); depth_i% = indent_pct + (overlap_pct - indent_pct) * x^L.
 * Volumes are multiplicative-martingale, sized so their sum equals the
 * leveraged budget (deposit_usdt * leverage) — this is MVP §8's "distribution
 * check", enforced by construction rather than validated separately.
 */
export function projectGrid(config: Config, entryPrice: number, dealId: string): GridPlan {
  if (!(entryPrice > 0)) {
    throw new Error('projectGrid: entryPrice must be positive');
  }

  const { overlap_pct, indent_pct, log_distribution, orders, martingale_pct } = config.grid;
  const budget = config.deposit_usdt * config.leverage;
  const m = martingale_pct / 100;

  const weights: number[] = [];
  for (let i = 1; i <= orders; i++) {
    weights.push(Math.pow(1 + m, i - 1));
  }
  const sumWeights = weights.reduce((sum, weight) => sum + weight, 0);
  const v1 = budget / sumWeights;

  const rungs: GridRung[] = [];
  for (let i = 1; i <= orders; i++) {
    const x = (i - 1) / (orders - 1);
    const depthPct = indent_pct + (overlap_pct - indent_pct) * Math.pow(x, log_distribution);
    const price = entryPrice * (1 - depthPct / 100);
    const notionalUsdt = v1 * (weights[i - 1] ?? 0);
    const size = notionalUsdt / price;

    rungs.push({
      index: i,
      depthPct,
      price,
      notionalUsdt,
      size,
      clientOrderId: `${dealId}-${String(i)}`,
    });
  }

  return { entryPrice, rungs };
}
