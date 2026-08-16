import type { OpenOrder, Position } from '../exchange/index.js';

export interface PlacedGridOrderSnapshot {
  clientOrderId: string;
  rungIndex: number;
  price: number;
  size: number;
  filledSize: number;
}

export interface PlacedExitOrderSnapshot {
  clientOrderId: string;
  type: 'tp' | 'sl';
  amount: number;
  filledSize: number;
}

export interface ReconcileTickInput {
  gridOrders: readonly PlacedGridOrderSnapshot[];
  exitOrders: readonly PlacedExitOrderSnapshot[];
  /** position.contracts as of the previous tick (or at GRID_PLACED start: 0). */
  previousContracts: number;
  openOrders: readonly OpenOrder[];
  position: Position;
}

export type ReconcileEvent =
  | { kind: 'partial_fill'; side: 'grid' | 'exit'; clientOrderId: string; filledSize: number }
  | { kind: 'rung_filled'; clientOrderId: string; rungIndex: number; fillPrice: number }
  | { kind: 'rung_cancelled'; clientOrderId: string; rungIndex: number }
  | { kind: 'exit_filled'; clientOrderId: string; exitType: 'tp' | 'sl' }
  | { kind: 'exit_cancelled'; clientOrderId: string; exitType: 'tp' | 'sl' }
  | { kind: 'position_diverged'; detail: string };
