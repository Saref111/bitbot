import pino from 'pino';
import type { Logger } from 'pino';
import { CreateLoggerOptions } from './types.js';
export type { Logger } from 'pino';

/**
 * MVP §13.6: TRACE/DEBUG/INFO/WARN/ERROR — pino's own level set covers all
 * five (plus 'fatal', unused here) exactly, so no custom level mapping is
 * needed. Default level 'info' per CLAUDE.md (production runs at INFO);
 * LOG_LEVEL env var overrides it, an explicit option overrides that.
 *
 * Dual destination, DIFFERENT format for each: console (stdout) is
 * human-readable immediately, no external pipe needed; the file stays raw
 * JSONL (the machine-readable source) with rotation. The file target is
 * only added when the caller passes `logFilePath` (unit tests that omit
 * options get console-only).
 *
 * Each target gets `level` passed EXPLICITLY — pino.transport with multiple
 * `targets` otherwise silently applies a default level of 'info' to EACH
 * target independently (it does not inherit the root logger's level), so
 * without this DEBUG/TRACE would vanish from both console and file even
 * with `level: 'debug'` at the top — verified empirically, not documented.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino-pretty',
      level,
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    },
  ];
  if (options.logFilePath) {
    targets.push({
      target: 'pino-roll',
      level,
      options: {
        file: options.logFilePath,
        frequency: 'daily',
        size: '20m',
        limit: { count: 14 },
        mkdir: true,
      },
    });
  }
  return pino({ level }, pino.transport({ targets }));
}

/** Default for OrchestratorContext.logger when the caller doesn't supply one — discards everything. */
export function createNoopLogger(): Logger {
  return pino({ level: 'silent' });
}
