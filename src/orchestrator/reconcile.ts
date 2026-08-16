import { EPS } from './constants.js';
import type { ExitOrderRow, GridOrderRow } from '../storage/index.js';
import type {
  ReconcileEvent,
  ReconcileTickInput,
  PlacedExitOrderSnapshot,
  PlacedGridOrderSnapshot,
} from './reconcileTypes.js';

/** The `previousContracts` baseline reconcileTick needs, derived from what's already committed to the DB. */
export function contractsImpliedByDb(
  gridRows: readonly GridOrderRow[],
  exitRows: readonly ExitOrderRow[],
): number {
  const grid = gridRows.reduce((sum, row) => {
    if (row.status === 'filled') return sum + row.size;
    if (row.status === 'placed') return sum + row.filledSize;
    return sum;
  }, 0);
  const exit = exitRows.reduce((sum, row) => {
    if (row.status === 'filled') return sum + row.amount;
    if (row.status === 'placed') return sum + row.filledSize;
    return sum;
  }, 0);
  return grid - exit;
}

/**
 * MVP §5/§9: classifies what happened to resting grid/exit orders between
 * two polls, using only fetchOpenOrders (with .filled) and fetchPosition —
 * no new read method needed.
 *
 * Core invariant: every unit of size is either DIRECTLY observed (a
 * still-open order's .filled increased — a PartialFill, never guessed) or
 * ATTRIBUTED to a disappeared order only if the measured position.contracts
 * delta exactly (within EPS) accounts for it, consumed greedily in
 * rungIndex order (the grid is monotonic in price, MVP §4.1, so simultaneous
 * disappearances resolve in the order they must have filled). Any leftover
 * or shortfall becomes a PositionDiverged, never a silent guess: a partial
 * fill immediately followed by an external cancel of the remainder, or
 * fetchPosition/fetchOpenOrders briefly disagreeing (two separate REST
 * calls, not one atomic snapshot), must not be misbooked as a clean fill.
 */
export function reconcileTick(input: ReconcileTickInput): ReconcileEvent[] {
  const openByClientOrderId = new Map(
    input.openOrders.map((order) => [order.clientOrderId, order]),
  );
  const events: ReconcileEvent[] = [];
  const anomalies: string[] = [];

  let observedGridIncrease = 0;
  for (const row of input.gridOrders) {
    const open = openByClientOrderId.get(row.clientOrderId);
    if (!open) continue;
    const delta = open.filled - row.filledSize;
    if (delta > EPS) {
      events.push({
        kind: 'partial_fill',
        side: 'grid',
        clientOrderId: row.clientOrderId,
        filledSize: open.filled,
      });
      observedGridIncrease += delta;
    }
  }

  let observedExitDecrease = 0;
  for (const row of input.exitOrders) {
    const open = openByClientOrderId.get(row.clientOrderId);
    if (!open) continue;
    const delta = open.filled - row.filledSize;
    if (delta > EPS) {
      events.push({
        kind: 'partial_fill',
        side: 'exit',
        clientOrderId: row.clientOrderId,
        filledSize: open.filled,
      });
      observedExitDecrease += delta;
    }
  }

  const netDelta = input.position.contracts - input.previousContracts;
  let gridBudget = Math.max(0, Math.max(0, netDelta) - observedGridIncrease);
  let exitBudget = Math.max(0, Math.max(0, -netDelta) - observedExitDecrease);

  const disappearedGrid: PlacedGridOrderSnapshot[] = input.gridOrders
    .filter((row) => !openByClientOrderId.has(row.clientOrderId))
    .slice()
    .sort((a, b) => a.rungIndex - b.rungIndex);

  for (const row of disappearedGrid) {
    const remaining = row.size - row.filledSize;
    if (remaining <= EPS) {
      events.push({
        kind: 'rung_filled',
        clientOrderId: row.clientOrderId,
        rungIndex: row.rungIndex,
        fillPrice: row.price,
      });
    } else if (gridBudget >= remaining - EPS) {
      events.push({
        kind: 'rung_filled',
        clientOrderId: row.clientOrderId,
        rungIndex: row.rungIndex,
        fillPrice: row.price,
      });
      gridBudget -= remaining;
    } else if (gridBudget > EPS) {
      anomalies.push(
        `grid rung ${String(row.rungIndex)} (${row.clientOrderId}) disappeared but only ` +
          `${String(gridBudget)} of its ${String(remaining)} remaining size is explained by the observed position delta`,
      );
      gridBudget = 0;
    } else {
      events.push({
        kind: 'rung_cancelled',
        clientOrderId: row.clientOrderId,
        rungIndex: row.rungIndex,
      });
    }
  }
  if (gridBudget > EPS) {
    anomalies.push(
      `position increased by ${String(gridBudget)} more than any disappeared grid rung explains`,
    );
  }

  const disappearedExit: PlacedExitOrderSnapshot[] = input.exitOrders.filter(
    (row) => !openByClientOrderId.has(row.clientOrderId),
  );

  for (const row of disappearedExit) {
    const remaining = row.amount - row.filledSize;
    if (remaining <= EPS) {
      events.push({ kind: 'exit_filled', clientOrderId: row.clientOrderId, exitType: row.type });
    } else if (exitBudget >= remaining - EPS) {
      events.push({ kind: 'exit_filled', clientOrderId: row.clientOrderId, exitType: row.type });
      exitBudget -= remaining;
    } else if (exitBudget > EPS) {
      anomalies.push(
        `exit order ${row.type} (${row.clientOrderId}) disappeared but only ` +
          `${String(exitBudget)} of its ${String(remaining)} remaining size is explained by the observed position delta`,
      );
      exitBudget = 0;
    } else {
      events.push({ kind: 'exit_cancelled', clientOrderId: row.clientOrderId, exitType: row.type });
    }
  }
  if (exitBudget > EPS) {
    anomalies.push(
      `position decreased by ${String(exitBudget)} more than any disappeared exit order explains`,
    );
  }

  if (anomalies.length > 0) {
    events.push({ kind: 'position_diverged', detail: anomalies.join('; ') });
  }

  return events;
}
