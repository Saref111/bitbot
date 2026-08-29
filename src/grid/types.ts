export interface GridRung {
  /** 1-based rung index (i in MVP §4: i = 1..N). */
  index: number;
  depthPct: number;
  price: number;
  notionalUsdt: number;
  size: number;
  clientOrderId: string;
}

export interface GridPlan {
  entryPrice: number;
  rungs: GridRung[];
}

export interface Fill {
  price: number;
  size: number;
}

/** Sprint 3 Task E: a single rung's price/size as observed from an external source (ExampleExchange preview screenshot, or a real Telegram fill reconstruction). */
export interface ObservedRung {
  price: number;
  size: number;
}

export interface RungDiff {
  index: number;
  observedPrice: number;
  computedPrice: number;
  /** (computedPrice - observedPrice) / anchor * 100 — anchor-relative, not per-rung-relative, so diffs stay comparable across rungs (mirrors Task C's percentage-point choice). */
  priceDiffPct: number;
  observedSize: number;
  computedSize: number;
  /** computedSize - observedSize, absolute ETH (AC #2 is stated in ETH steps, not percent). */
  sizeDiff: number;
  withinTolerance: boolean;
}

export interface AverageDiff {
  observedAverage: number;
  computedAverage: number;
  diffPct: number;
  withinTolerance: boolean;
}

export interface GridFidelityReport {
  /** One row per OBSERVED index — a rung absent from the input map (unobserved, or deliberately excluded, e.g. rung 1 on the real-fill path) never appears here. */
  rungs: readonly RungDiff[];
  /** null when there is no independent average ground truth to check (the real-fill path). */
  average: AverageDiff | null;
  allWithinTolerance: boolean;
}
