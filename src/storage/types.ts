import type { Config, Direction } from '../config/index.js';

export type DealStatus = 'WAITING_SIGNAL' | 'GRID_PLACED' | 'ACTIVE' | 'SETTLING' | 'HALTED';
export type DealCloseReason = 'tp' | 'sl' | 'liquidation' | 'runaway' | 'error';
export type GridOrderStatus = 'pending' | 'placed' | 'filled' | 'cancelled';
export type ExitOrderType = 'tp' | 'sl';
export type ExitOrderStatus = 'placed' | 'filled' | 'cancelled';

export interface DealRow {
  id: string;
  status: DealStatus;
  direction: Direction;
  pEntry: number | null;
  filledRungsCount: number;
  depositUsdt: number;
  closeReason: DealCloseReason | null;
  openedAt: number;
  closedAt: number | null;
  netProfit: number | null;
}

export interface GridOrderRow {
  id: number;
  dealId: string;
  rungIndex: number;
  price: number;
  size: number;
  clientOrderId: string;
  status: GridOrderStatus;
  createdAt: number;
  placedAt: number | null;
  filledAt: number | null;
  cancelledAt: number | null;
  fillPrice: number | null;
  filledSize: number;
}

export interface ExitOrderRow {
  id: number;
  dealId: string;
  type: ExitOrderType;
  clientOrderId: string;
  price: number;
  amount: number;
  status: ExitOrderStatus;
  createdAt: number;
  filledAt: number | null;
  cancelledAt: number | null;
  filledSize: number;
}

export interface EventLogRow {
  id: number;
  dealId: string | null;
  eventType: string;
  payloadJson: string | null;
  createdAt: number;
}

// Only the write/restore DTOs that actually cross the storage/ module
// boundary (consumed by orchestrator/) live here. NewDeal/DealPatch,
// NewEvent, NewGridOrder, ExitOrderPatch, PlaceGridParams stay colocated
// with their one repository file — nothing outside storage/ imports them.

export interface GridOrderPatch {
  status: GridOrderStatus;
  placedAt?: number;
  filledAt?: number;
  cancelledAt?: number;
  fillPrice?: number;
  filledSize?: number;
}

export interface NewExitOrder {
  dealId: string;
  type: ExitOrderType;
  clientOrderId: string;
  price: number;
  amount: number;
  createdAt: number;
}

export interface RestoredDeal {
  deal: DealRow;
  gridOrders: GridOrderRow[];
  exitOrders: ExitOrderRow[];
  config: Config | null;
}

export interface NewDeal {
  id: string;
  status: DealStatus;
  direction: Direction;
  depositUsdt: number;
  openedAt: number;
}

export interface DealPatch {
  status?: DealStatus;
  pEntry?: number;
  filledRungsCount?: number;
  depositUsdt?: number;
  closeReason?: DealCloseReason;
  closedAt?: number;
  /** undefined = don't touch; null = explicitly clear (e.g. computeNet failed); number = the computed NET. */
  netProfit?: number | null;
}

export interface NewEvent {
  dealId: string | null;
  eventType: string;
  payload?: unknown;
  createdAt: number;
}

export interface ExitOrderPatch {
  status: ExitOrderStatus;
  filledAt?: number;
  cancelledAt?: number;
  filledSize?: number;
}

export interface NewGridOrder {
  rungIndex: number;
  price: number;
  size: number;
  clientOrderId: string;
}

export interface PlaceGridParams {
  dealId: string;
  pEntry: number;
  rungs: readonly NewGridOrder[];
  config: Config;
  at: number;
}
