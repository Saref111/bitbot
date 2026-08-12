export type DealStatus = 'WAITING_SIGNAL' | 'GRID_PLACED' | 'ACTIVE' | 'SETTLING' | 'HALTED';
export type DealCloseReason = 'tp' | 'sl' | 'liquidation' | 'runaway' | 'error';
export type GridOrderStatus = 'pending' | 'placed' | 'filled' | 'cancelled';
export type ExitOrderType = 'tp' | 'sl';
export type ExitOrderStatus = 'placed' | 'filled' | 'cancelled';

export interface DealRow {
  id: string;
  status: DealStatus;
  direction: 'long' | 'short';
  pEntry: number | null;
  filledRungsCount: number;
  depositUsdt: number;
  closeReason: DealCloseReason | null;
  openedAt: number;
  closedAt: number | null;
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
}

export interface ExitOrderRow {
  id: number;
  dealId: string;
  type: ExitOrderType;
  clientOrderId: string;
  price: number;
  status: ExitOrderStatus;
  createdAt: number;
  filledAt: number | null;
  cancelledAt: number | null;
}

export interface EventLogRow {
  id: number;
  dealId: string | null;
  eventType: string;
  payloadJson: string | null;
  createdAt: number;
}
