import pino from 'pino';
import type { Logger } from 'pino';
import { CreateLoggerOptions } from './types.js';
export type { Logger } from 'pino';

/**
 * MVP §13.6: TRACE/DEBUG/INFO/WARN/ERROR — pino's own level set covers all
 * five (plus 'fatal', unused here) exactly, so no custom level mapping is
 * needed. Default level 'info' per CLAUDE.md ("у проді рівень INFO");
 * LOG_LEVEL env var overrides it, an explicit option overrides that.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const targets: pino.TransportTargetOptions[] = [
    { target: 'pino/file', options: { destination: 1 } },
  ];
  if (options.logFilePath) {
    targets.push({
      target: 'pino/file',
      options: { destination: options.logFilePath, mkdir: true },
    });
  }
  return pino({ level }, pino.transport({ targets }));
}

/** Default for OrchestratorContext.logger when the caller doesn't supply one — discards everything. */
export function createNoopLogger(): Logger {
  return pino({ level: 'silent' });
}
