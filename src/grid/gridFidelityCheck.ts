import { averageEntry } from './averageEntry.js';
import type { AverageDiff, GridFidelityReport, GridPlan, ObservedRung, RungDiff } from './types.js';

export interface GridFidelityTolerances {
  /** Relative to plan.entryPrice (anchor), not the observed rung's own price — see priceDiffPct's own doc comment on RungDiff. */
  pricePct: number;
  /** Absolute ETH (AC #2: "до кроку 0.001 ETH"). */
  sizeEth: number;
  averagePct: number;
}

/**
 * Sprint 3 Task E: diffs a computed GridPlan against externally observed
 * rung data (a ExampleExchange preview screenshot, or a real Telegram fill
 * reconstruction). Only iterates `observedRungs` — a rung absent from the
 * map (unobserved on a screenshot, or deliberately excluded, e.g. rung 1
 * on the real-fill path since it's the anchor-defining rung there) simply
 * never appears in the report. `observedAverage: null` models the
 * real-fill path's lack of an independent "amplitude-weighted average of
 * all N rungs" ground truth (Telegram's own cumulative avgPrice is a
 * different quantity, not that).
 */
export function checkGridFidelity(
  plan: GridPlan,
  observedRungs: ReadonlyMap<number, ObservedRung>,
  observedAverage: number | null,
  tolerances: GridFidelityTolerances,
): GridFidelityReport {
  const rungs: RungDiff[] = [];

  for (const [index, observed] of observedRungs) {
    const rung = plan.rungs.find((r) => r.index === index);
    if (!rung) {
      throw new Error(
        `checkGridFidelity: observed rung index ${String(index)} has no matching rung in the plan (plan has ${String(plan.rungs.length)} rungs)`,
      );
    }

    const priceDiffPct = ((rung.price - observed.price) / plan.entryPrice) * 100;
    const sizeDiff = rung.size - observed.size;
    const withinTolerance =
      Math.abs(priceDiffPct) <= tolerances.pricePct && Math.abs(sizeDiff) <= tolerances.sizeEth;

    rungs.push({
      index,
      observedPrice: observed.price,
      computedPrice: rung.price,
      priceDiffPct,
      observedSize: observed.size,
      computedSize: rung.size,
      sizeDiff,
      withinTolerance,
    });
  }

  let average: AverageDiff | null = null;
  if (observedAverage !== null) {
    const computedAverage = averageEntry(plan.rungs.map((r) => ({ price: r.price, size: r.size })));
    const diffPct = ((computedAverage - observedAverage) / observedAverage) * 100;
    average = {
      observedAverage,
      computedAverage,
      diffPct,
      withinTolerance: Math.abs(diffPct) <= tolerances.averagePct,
    };
  }

  return {
    rungs,
    average,
    allWithinTolerance: rungs.every((r) => r.withinTolerance) && (average === null || average.withinTolerance),
  };
}
