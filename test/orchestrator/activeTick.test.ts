import { describe, expect, it, vi } from 'vitest';
import { warnIfLiquidationEntersGrid } from '../../src/orchestrator/activeTick.js';
import type { Logger } from '../../src/logging/index.js';
import type { GridOrderRow } from '../../src/storage/types.js';

function row(overrides: Partial<GridOrderRow> = {}): GridOrderRow {
  return {
    id: 1,
    dealId: 'deal-1',
    rungIndex: 1,
    price: 1897.74,
    size: 0.018,
    clientOrderId: 'deal-1-1',
    status: 'placed',
    createdAt: 1000,
    placedAt: 1000,
    filledAt: null,
    cancelledAt: null,
    fillPrice: null,
    filledSize: 0,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

describe('warnIfLiquidationEntersGrid — long (grid below entry, deepest = lowest live price)', () => {
  it('does nothing when liquidationPrice is null', () => {
    const logger = makeLogger();
    warnIfLiquidationEntersGrid(logger, [row({ price: 1800 })], null, 'long');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns once liquidationPrice reaches the deepest (lowest) live rung price', () => {
    const logger = makeLogger();
    const gridRows = [row({ price: 1900 }), row({ price: 1800 }), row({ price: 1700 })];
    warnIfLiquidationEntersGrid(logger, gridRows, 1700, 'long');
    expect(logger.warn).toHaveBeenCalledWith(
      { liquidationPrice: 1700, deepestRungPrice: 1700 },
      "liquidation price has reached the grid's deepest resting rung",
    );
  });

  it('does not warn while liquidationPrice is still below the deepest live rung', () => {
    const logger = makeLogger();
    const gridRows = [row({ price: 1900 }), row({ price: 1700 })];
    warnIfLiquidationEntersGrid(logger, gridRows, 1600, 'long');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ignores cancelled rows when finding the deepest live price', () => {
    const logger = makeLogger();
    const gridRows = [row({ price: 1900 }), row({ price: 1500, status: 'cancelled' })];
    // Deepest LIVE rung is 1900, not the cancelled 1500 one.
    warnIfLiquidationEntersGrid(logger, gridRows, 1900, 'long');
    expect(logger.warn).toHaveBeenCalledWith(
      { liquidationPrice: 1900, deepestRungPrice: 1900 },
      "liquidation price has reached the grid's deepest resting rung",
    );
  });
});

// Sprint 4 Task A, Slice 5: not full mirror-symmetry validation (Task B's
// job) — enough to prove 'short' actually flips both the aggregation
// (max instead of min) and the comparison direction, not just the sign.
describe('warnIfLiquidationEntersGrid — short (grid above entry, deepest = highest live price)', () => {
  it('warns once liquidationPrice falls to the deepest (highest) live rung price', () => {
    const logger = makeLogger();
    const gridRows = [row({ price: 2100 }), row({ price: 2200 }), row({ price: 2300 })];
    warnIfLiquidationEntersGrid(logger, gridRows, 2300, 'short');
    expect(logger.warn).toHaveBeenCalledWith(
      { liquidationPrice: 2300, deepestRungPrice: 2300 },
      "liquidation price has reached the grid's deepest resting rung",
    );
  });

  it('does not warn while liquidationPrice is still above the deepest live rung', () => {
    const logger = makeLogger();
    const gridRows = [row({ price: 2100 }), row({ price: 2300 })];
    warnIfLiquidationEntersGrid(logger, gridRows, 2400, 'short');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
