import {
  createBinanceAdapter,
  createBinanceCcxtClient,
  createBinanceFillWatcher,
  createBinanceProCcxtClient,
  createBybitAdapter,
  createBybitCcxtClient,
  createBybitProCcxtClient,
  loadBybitCredentials,
  loadExchangeCredentials,
} from './exchange/index.js';
import { loadConfigFromFile } from './config/index.js';
import { getMostRecentOpenDeal, openDatabase } from './storage/index.js';
import { createLogger, createNoopLogger, resolveLogLevel } from './logging/index.js';
import type { LogLevel } from './logging/index.js';
import {
  createNoopNotifier,
  createTelegramNotifier,
  loadTelegramCredentials,
} from './notify/index.js';
import {
  adoptExistingPosition,
  announceSessionStart,
  recoverDeal,
  waitAndOpenDeal,
} from './orchestrator/index.js';
import type { ExchangeAdapter, FillWatcher } from './exchange/index.js';
import type {
  OrchestratorContext,
  RecoverDealResult,
  RunDealResult,
} from './orchestrator/index.js';

export type Network = 'testnet' | 'mainnet';

function assertNever(value: never): never {
  throw new Error(`buildOrchestratorContext: unhandled exchange: ${String(value)}`);
}

/**
 * Real bootstrap — file/env I/O, constructs real ccxt clients. Not unit
 * tested (same as binanceClient.ts): there's nothing here for a mock to
 * usefully stand in for. The FillWatcher comes back separately from `ctx`
 * rather than as a field on it — OrchestratorContext deliberately has no
 * fillWatcher (MVP §13.5 keeps it per-call, in RunDealOptions, not
 * per-context); changing that stable type just for this composition point
 * isn't worth the risk.
 */
export function buildOrchestratorContext(
  configPath: string,
  dbPath: string,
  cliLogLevel?: LogLevel,
  logFilePath?: string,
): { ctx: OrchestratorContext; fillWatcher: FillWatcher; network: Network } {
  const config = loadConfigFromFile(configPath);

  // Sprint 4 Task C, Slice C3: reads config.exchange directly at this one
  // construction point, rather than threading a separate exchange
  // parameter through buildOrchestratorContext — config is already in
  // scope here, same reasoning as Task A's direction widening. No runtime
  // guard needed for the new 'bybit-futures' branch (unlike Task A's
  // direction guard): that guard existed because the deal-state machine
  // was mid-refactor between slices; here 'bybit-futures' routes to a
  // complete, unit-tested adapter (Slices C2/C2b) — the only thing not yet
  // proven is real-testnet mechanics (Slice C4), not a half-wired state.
  let adapter: ExchangeAdapter;
  let fillWatcher: FillWatcher;
  let network: Network;
  switch (config.exchange) {
    case 'binance-futures': {
      const credentials = loadExchangeCredentials();
      network = credentials.testnet ? 'testnet' : 'mainnet';
      adapter = createBinanceAdapter(createBinanceCcxtClient(credentials));
      fillWatcher = createBinanceFillWatcher(createBinanceProCcxtClient(credentials));
      break;
    }
    case 'bybit-futures': {
      const credentials = loadBybitCredentials();
      network = credentials.testnet ? 'testnet' : 'mainnet';
      adapter = createBybitAdapter(createBybitCcxtClient(credentials));
      // createBinanceFillWatcher, reused as-is: it only depends on
      // WatchOrdersLike (fillWatcher.ts), nothing Binance-specific,
      // despite the name — confirmed structurally in Slice C1/C2.
      // WS connect/wake not yet exercised on Bybit — structurally shared
      // with the Binance path, source-confirmed in Slice C1 (pro/bybit.js's
      // getUrlByMarketType correctly routes to the demo private stream),
      // but no test ever constructs a real createBybitProCcxtClient (Slice
      // C4's mechanics test is REST-only). Degrades safely if wrong (the
      // watcher only wakes reconcileTick early; a dead WS just falls back
      // to plain poll cadence, not data corruption) — deferred to Task D.
      fillWatcher = createBinanceFillWatcher(createBybitProCcxtClient(credentials));
      break;
    }
    default:
      assertNever(config.exchange);
  }

  const db = openDatabase(dbPath);
  const level = resolveLogLevel({
    ...(cliLogLevel !== undefined ? { cli: cliLogLevel } : {}),
    ...(process.env.LOG_LEVEL !== undefined ? { env: process.env.LOG_LEVEL } : {}),
    ...(config.logging?.level !== undefined ? { config: config.logging.level } : {}),
  });
  const logger = createLogger({ level, ...(logFilePath !== undefined ? { logFilePath } : {}) });

  const telegramCredentials = loadTelegramCredentials();
  const notifier = telegramCredentials
    ? createTelegramNotifier(telegramCredentials)
    : createNoopNotifier();
  if (!telegramCredentials) {
    logger.info(
      'Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset) — using no-op notifier',
    );
  }

  return {
    ctx: { adapter, db, config, now: () => Date.now(), logger, notifier },
    fillWatcher,
    network,
  };
}

function defaultGenerateDealId(): string {
  return `deal-${Date.now().toString(36)}`;
}

function isStopOutcome(result: RunDealResult | RecoverDealResult): boolean {
  return result.outcome === 'halted' || result.outcome === 'shutdown';
}

/**
 * The bot's whole life after bootstrap: PLAN.md's Зріз 13 startup ordering
 * (adopt an existing exchange position, or resume an in-flight deal from a
 * previous run, whichever applies) followed by the endless
 * WAITING_SIGNAL -> deal -> WAITING_SIGNAL cycle — one deal at a time, a new
 * dealId each iteration, MVP scope. `halted` and `shutdown` both stop this
 * loop (the former needs a human, the latter resumes automatically via
 * recoverDeal next start) — everything else (closed/runaway/no-deal) just
 * means "on to the next deal."
 */
export async function runBot(
  ctx: OrchestratorContext,
  options: {
    signal?: AbortSignal;
    fillWatcher?: FillWatcher;
    generateDealId?: () => string;
    /** For the startup visibility banner (announceSessionStart) — defaults conservatively when omitted (test callers only). */
    network?: Network;
  } = {},
): Promise<void> {
  const generateDealId = options.generateDealId ?? defaultGenerateDealId;
  const dealOptions = {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.fillWatcher !== undefined ? { fillWatcher: options.fillWatcher } : {}),
  };

  await announceSessionStart({
    config: ctx.config,
    db: ctx.db,
    logger: ctx.logger ?? createNoopLogger(),
    notifier: ctx.notifier ?? createNoopNotifier(),
    network: options.network ?? 'testnet',
    now: ctx.now,
  });

  if (ctx.config.include_existing_position) {
    const result = await adoptExistingPosition({
      ...ctx,
      dealId: generateDealId(),
      options: dealOptions,
    });
    if (result && isStopOutcome(result)) return;
  } else {
    const openDeal = getMostRecentOpenDeal(ctx.db);
    if (openDeal) {
      const result = await recoverDeal({ ...ctx, dealId: openDeal.id, options: dealOptions });
      if (isStopOutcome(result)) return;
    }
  }

  for (;;) {
    if (options.signal?.aborted) return;

    const result = await waitAndOpenDeal({
      ...ctx,
      dealId: generateDealId(),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.fillWatcher !== undefined ? { fillWatcher: options.fillWatcher } : {}),
    });
    if (isStopOutcome(result)) return;
  }
}
