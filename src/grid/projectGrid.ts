import type { Config } from '../config/index.js';
import type { GridPlan, GridRung } from './types.js';

/**
 * MVP §4.1: grid prices follow a TWO-STAGE power-law curve, not one curve
 * from anchor. Stage 1: rung 1 sits at indent_pct depth from anchor
 * (entryPrice). Stage 2: rungs 2..N follow a power-law curve x^L measured
 * from RUNG 1's OWN price, using the FULL overlap_pct (not overlap_pct -
 * indent_pct). x = (i-1)/(N-1).
 *
 * This was confirmed against real live-order data (Sprint 3 Task E):
 * P_entry 1901.54, L 1.3 -> rungs 1897.74 / 1874.07 / 1839.46 (see
 * CLAUDE.md / docs/MVP-done.md §4.1). A single-stage "depth = indent +
 * (overlap-indent)*x^L from anchor" formula — the easy, obvious-looking
 * simplification — was shipped originally and is WRONG: it gives
 * 1874.16/1839.67 for the same inputs, a real, systematic, depth-growing
 * error, independently reconfirmed against a real ExampleExchange preview
 * screenshot. Do not simplify back to one curve from anchor.
 *
 * depthPct on each rung is still reported as "% from anchor" (for
 * external/debug consistency) even though it's now derived from the
 * two-stage price, not the other way around — at rung N this is
 * indent_pct + overlap_pct - indent_pct*overlap_pct/100, NOT overlap_pct
 * itself (overlap_pct is the depth from RUNG 1, not from anchor).
 *
 * Volumes are multiplicative-martingale, sized so their sum equals the
 * leveraged budget (deposit_usdt * leverage) — this is MVP §8's "distribution
 * check", enforced by construction rather than validated separately.
 *
 * Sprint 4 Task A: `config.direction` picks which side of entryPrice the
 * grid sits on via `sideSign` (-1 long, +1 short) in both price stages —
 * read off `config` like every other grid parameter here (deposit, leverage,
 * grid.*), not a separate argument: projectGrid is called exactly once per
 * deal, immediately next to a freshly-written config, so there's never a
 * call site where the correct direction differs from config.direction
 * (unlike decide/deliverNextRungs/reconcileExitTargets, which run
 * repeatedly across a deal's lifecycle and sometimes need deal.direction
 * instead). `Config['direction']` is the real `'long'|'short'` union
 * (config/schema.ts widened it from z.enum(['long'])), so this comparison
 * is genuinely reachable at the type level — no dead-code lint complaint,
 * no cast. For direction='long', sideSign=-1 makes every `sideSign*...`
 * term the exact negation used before this parameter existed, so
 * `(1 + sideSign*x)` is `(1 - x)` bit-for-bit (IEEE 754 negation is exact)
 * — LONG output is unchanged, not just numerically close. depthPct is
 * normalized by `-sideSign` for the same reason: for long, `-sideSign` is
 * `1`, so `-sideSign*(1 - price/entryPrice)*100` is
 * `(1 - price/entryPrice)*100` verbatim; for short (price above entryPrice)
 * it flips the otherwise-negative raw distance back to the same "% away
 * from anchor" magnitude convention.
 */
export function projectGrid(config: Config, entryPrice: number, dealId: string): GridPlan {
  if (!(entryPrice > 0)) {
    throw new Error('projectGrid: entryPrice must be positive');
  }

  const sideSign = config.direction === 'long' ? -1 : 1;
  const { overlap_pct, indent_pct, log_distribution, orders, martingale_pct } = config.grid;
  const budget = config.deposit_usdt * config.leverage;
  const m = martingale_pct / 100;

  const weights: number[] = [];
  for (let i = 1; i <= orders; i++) {
    weights.push(Math.pow(1 + m, i - 1));
  }
  const sumWeights = weights.reduce((sum, weight) => sum + weight, 0);
  const v1 = budget / sumWeights;

  const rung1Price = entryPrice * (1 + sideSign * (indent_pct / 100));

  const rungs: GridRung[] = [];
  for (let i = 1; i <= orders; i++) {
    const x = (i - 1) / (orders - 1);
    const price =
      i === 1
        ? rung1Price
        : rung1Price * (1 + sideSign * ((overlap_pct * Math.pow(x, log_distribution)) / 100));
    const depthPct = -sideSign * (1 - price / entryPrice) * 100;
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
