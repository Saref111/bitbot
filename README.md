# bitbot

Personal futures grid-DCA trading bot for Binance USDM Futures. Single
"Simple" strategy mode: waits for a set of indicator filters to align, opens
a martingale grid, averages down on fills, takes profit off the average
entry, and repeats — one deal at a time, on one symbol, on one exchange.

## Status

MVP complete. No UI, no multi-user, no strategy modes beyond "Simple", one
deal in flight at a time. This is a personal single-instance tool, not a
general-purpose trading platform.

## Requirements

- Node.js **24 LTS** or newer (`engines.node` in `package.json`) — required
  for `node:sqlite` to work reliably; earlier versions either lack it or
  only have it as experimental.
- A Binance account with USDM Futures API keys (testnet or live).

## Setup

```bash
npm install
cp .env.example .env        # fill in API keys below
cp config.example.yaml config.yaml   # edit strategy parameters
```

### `.env`

```
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_TESTNET=true|false

TELEGRAM_BOT_TOKEN=   # optional
TELEGRAM_CHAT_ID=     # optional
```

`BINANCE_TESTNET` is the actual switch between Binance's futures testnet and
the live exchange — this, not anything in the YAML config, decides which one
the bot talks to. API keys should always be **trade-only**, never
withdrawal-enabled.

`LOG_LEVEL` (optional, default `info`) can also be set here or in the shell
environment — one of pino's levels: `trace`/`debug`/`info`/`warn`/`error`.

### `config.yaml`

See `config.example.yaml` for a complete example and `docs/MVP.md §3` for
the full field-by-field spec (local-only doc, not in this repo). Shape,
briefly:

- `symbol` / `direction` / `exchange` — market and venue (`direction`
  currently only supports `long`).
- `deposit_usdt` / `leverage` / `margin_mode` / `reinvest_pct` — position
  sizing; profitable deals compound `reinvest_pct`% of NET profit into the
  next deal's deposit automatically.
- `entry_filters` — a list of `{ indicator, timeframe, period, op, value }`
  conditions (RSI/CCI), AND-gated, each evaluated only on its own
  timeframe's closed bar. An empty list enters immediately.
- `grid` — `overlap_pct`/`indent_pct`/`log_distribution` shape the grid's
  price curve; `orders` is the rung count; `martingale_pct` grows each
  rung's size; `partial_placement` caps how many rungs rest on the exchange
  at once (`null` = all of them); `runaway_cancel_pct` cancels an
  unfilled grid if price runs away before any fill.
- `take_profit_pct` / `stop_loss` / `halt_after_loss` — exit rules.
  `stop_loss: null` disables it.
- `include_existing_position` — on startup, adopt whatever position is
  already open on the exchange into a new deal (TP/SL only, no
  reconstructed grid) instead of waiting for a fresh entry signal.
- `testnet` in the YAML itself is currently a required schema field but not
  actually read by anything — `.env`'s `BINANCE_TESTNET` is the real switch.

## Running

```bash
npm start -- --config config.yaml [--db path/to/state.db]
```

- `--config <path>` — required, path to the strategy config YAML.
- `--db <path>` — optional, defaults to the config file's own path with a
  `.db` extension (`config.yaml` → `config.db`, same directory).

`npm start` builds (`tsc`) and then runs the compiled entry point. To build
once and run separately (e.g. for a systemd service):

```bash
npm run build
node dist/src/bin/bitbot.js --config config.yaml
```

### What happens on startup

1. If `include_existing_position` is `true`, adopts whatever position is
   already open on the exchange into a new deal.
2. Otherwise, if the database has a deal left in flight from a previous run
   (crash, restart, deploy), resumes it from where it left off.
3. Then enters the normal loop: wait for `entry_filters` to align → open a
   deal → drive it to a close → repeat, one deal at a time, until stopped.

### Stopping

`Ctrl+C` (SIGINT) or `SIGTERM` stops the bot gracefully: whatever exchange
call is already in flight finishes normally, then the bot stops at the next
tick boundary — never mid-order. An in-flight deal is **not** cancelled; it
resumes automatically via the same recovery path on the next start.

If a deal **HALTS** (external interference, liquidation, or
`halt_after_loss`), the bot logs it, sends a Telegram notification if
configured, and stops — it will not start a new deal on its own. Halting
needs a human to look at what happened before resuming.

### Notifications

If `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set, the bot sends a message
on deal open, averaging, close, and always on HALTED. Without them it just
logs — notifications are an optional visibility channel, not required to
run.

## Development

```bash
npm test              # unit tests (vitest)
npm run test:integration   # integration tests against Binance testnet (needs .env keys)
npm run lint
npm run typecheck
npm run format
npm run build          # compile src/ (and test/) to dist/
```

## Safety

- Always test against `BINANCE_TESTNET=true` with testnet-only keys before
  running live.
- API keys must never have withdrawal permission.
- This bot runs one deal at a time on one symbol — it is not designed for
  concurrent strategies or multiple accounts.
