// MVP §10: minimum tables to survive a restart, each carrying event timestamps.
// FK constraints (grid_order/exit_order/config_snapshot/event_log -> deal)
// mean deal must be inserted first — insertDeal() before placeGrid() /
// insertExitOrder() / appendEvent() with a dealId. A violation throws
// loudly (node:sqlite enforces FKs by default), it won't silently corrupt.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS deal (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  direction TEXT NOT NULL,
  p_entry REAL,
  filled_rungs_count INTEGER NOT NULL DEFAULT 0,
  deposit_usdt REAL NOT NULL,
  close_reason TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  -- gross profit - fees (both legs) + funding, computed once at
  -- SETTLING/HALTED. NULL until then, and stays NULL if it was never
  -- computed (runaway, external-cancel HALT, or computeNet itself failing)
  -- — resolveDeposit.ts treats NULL the same as "no growth this cycle".
  net_profit REAL
);

CREATE TABLE IF NOT EXISTS grid_order (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT NOT NULL REFERENCES deal(id),
  rung_index INTEGER NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  placed_at INTEGER,
  filled_at INTEGER,
  cancelled_at INTEGER,
  fill_price REAL,
  -- cumulative filled amount while still resting (Binance futures
  -- limit orders can fill partially before fully resolving) — reconcile.ts
  -- diffs this against the exchange's live OpenOrder.filled each tick.
  filled_size REAL NOT NULL DEFAULT 0,
  UNIQUE (deal_id, rung_index)
);

CREATE TABLE IF NOT EXISTS exit_order (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT NOT NULL REFERENCES deal(id),
  type TEXT NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  price REAL NOT NULL,
  -- full order amount at placement time (== position.contracts
  -- then) — needed to compute remaining = amount - filled_size, the same
  -- way grid_order.size is used, for reconcile.ts's budget accounting.
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  filled_at INTEGER,
  cancelled_at INTEGER,
  filled_size REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS config_snapshot (
  deal_id TEXT PRIMARY KEY REFERENCES deal(id),
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT REFERENCES deal(id),
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
`;
