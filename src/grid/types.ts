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
