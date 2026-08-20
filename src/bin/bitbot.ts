#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { dirname, join, basename, extname } from 'node:path';
import { buildOrchestratorContext, runBot } from '../main.js';
import { logLevels, type LogLevel } from '../logging/index.js';

export function parseArgs(
  argv: readonly string[],
): { configPath: string; dbPath: string; logLevel?: LogLevel } {
  let configPath: string | undefined;
  let dbPath: string | undefined;
  let logLevel: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configPath = argv[++i];
    else if (argv[i] === '--db') dbPath = argv[++i];
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

async function run(): Promise<void> {
  loadDotenv();
  const { configPath, dbPath, logLevel } = parseArgs(process.argv.slice(2));
  const { ctx, fillWatcher, network } = buildOrchestratorContext(configPath, dbPath, logLevel);

  const controller = new AbortController();
  let shuttingDown = false;
  const onSignal = (signalName: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
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
