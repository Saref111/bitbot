export { insertDeal, updateDeal, getMostRecentClosedDeal, getDeal } from './dealRepository.js';
export { restoreDeal } from './restoreDeal.js';
export { appendEvent } from './eventLogRepository.js';
export {
  insertGridOrders,
  updateGridOrderStatus,
  getGridOrdersByDeal,
} from './gridOrderRepository.js';
export {
  insertExitOrder,
  getExitOrdersByDeal,
  updateExitOrderStatus,
} from './exitOrderRepository.js';
export { insertConfigSnapshot } from './configSnapshotRepository.js';
export { placeGrid } from './placeGrid.js';
export { runInTransaction } from './transaction.js';
export type {
  ExitOrderRow,
  NewExitOrder,
  RestoredDeal,
  DealCloseReason,
  GridOrderRow,
  GridOrderPatch,
} from './types.js';
