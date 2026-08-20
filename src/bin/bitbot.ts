#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { dirname, join, basename, extname } from 'node:path';
import { buildOrchestratorContext, runBot } from '../main.js';
import { createNoopLogger, logLevels, type LogLevel } from '../logging/index.js';
import { createNoopNotifier } from '../notify/index.js';
import { announceSessionStop } from '../orchestrator/index.js';

export function parseArgs(
  argv: readonly string[],
): { configPath: string; dbPath: string; logFilePath: string; logLevel?: LogLevel } {
  let configPath: string | undefined;
  let dbPath: string | undefined;
  let logFilePath: string | undefined;
  let logLevel: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configPath = argv[++i];
    else if (argv[i] === '--db') dbPath = argv[++i];
    else if (argv[i] === '--log-file') logFilePath = argv[++i];
    else if (argv[i] === '--log-level') logLevel = argv[++i];
  }
  if (!configPath) {
    throw new Error('bitbot: --config <path> is required');
  }
  if (logLevel !== undefined && !isLogLevel(logLevel)) {
    throw new Error(
      `bitbot: --log-level must be one of ${logLevels.join('|')}, got "${logLevel}"`,
    );
  }
  return {
    configPath,
    dbPath: dbPath ?? deriveDefaultDbPath(configPath),
    logFilePath: logFilePath ?? deriveDefaultLogPath(configPath),
    ...(logLevel !== undefined ? { logLevel } : {}),
  };
}

function isLogLevel(value: string): value is LogLevel {
  return (logLevels as readonly string[]).includes(value);
}

/** "Next to the config" (PLAN.md): same directory, config's own filename with a .db extension. */
export function deriveDefaultDbPath(configPath: string): string {
  const base = basename(configPath, extname(configPath));
  return join(dirname(configPath), `${base}.db`);
}

/**
 * Symmetric to deriveDefaultDbPath. This is the BASE path handed to
 * pino-roll's `file` option, not the literal name of the file that ends up
 * on disk — pino-roll always appends its own rotation suffix (a count
 * and/or date), so the real file is e.g. `config.1.log`, never `config.log`
 * itself. Tooling that wants "the current log" should glob `config*.log`.
 */
export function deriveDefaultLogPath(configPath: string): string {
  const base = basename(configPath, extname(configPath));
  return join(dirname(configPath), `${base}.log`);
}

async function run(): Promise<void> {
  loadDotenv();
  const { configPath, dbPath, logFilePath, logLevel } = parseArgs(process.argv.slice(2));
  const { ctx, fillWatcher, network } = buildOrchestratorContext(
    configPath,
    dbPath,
    logLevel,
    logFilePath,
  );

  const controller = new AbortController();
  // An object, not a bare `let` — a plain boolean gets narrowed to its
  // literal `false` at declaration and TS won't widen it back across the
  // `await runBot(...)` below even though a SIGINT/SIGTERM handler can flip
  // it asynchronously in between; a property read isn't narrowed that way.
  const shutdown = { requested: false };
  const onSignal = (signalName: string): void => {
    if (shutdown.requested) return;
    shutdown.requested = true;
    ctx.logger?.info(
      { signal: signalName },
      'shutdown requested, stopping at the next tick boundary',
    );
    controller.abort();
  };
  process.on('SIGINT', () => {
    onSignal('SIGINT');
  });
  process.on('SIGTERM', () => {
    onSignal('SIGTERM');
  });

  await runBot(ctx, { signal: controller.signal, fillWatcher, network });

  // Paired with buildOrchestratorContext -> runBot's startup announcement
  // (announceSessionStart). Only for a graceful signal-triggered stop —
  // runBot returning for any other reason (halted, closed with no restart,
  // etc.) leaves shutdown.requested false, so this stays silent then.
  // Awaited so the process doesn't exit before the Telegram ping sends.
  if (shutdown.requested) {
    await announceSessionStop({
      config: ctx.config,
      db: ctx.db,
      logger: ctx.logger ?? createNoopLogger(),
      notifier: ctx.notifier ?? createNoopNotifier(),
      network,
      now: ctx.now,
    });
  }
}

// Guards the real run() so importing this module (as test/bin/bitbot.test.ts
// does, for parseArgs/deriveDefaultDbPath) never triggers a live bootstrap
// against process.argv/env — only actually running this file as the entry
// point does.
if (import.meta.main) {
  run().catch((error: unknown) => {
    // No logger may exist yet if bootstrap itself failed (bad config,
    // missing env) — the most likely early failure — so this is a
    // deliberate fallback, not a missed opportunity to use the real logger.
    console.error('bitbot: fatal error', error);
    process.exit(1);
  });
}
