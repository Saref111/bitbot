import type { LogLevel } from './types.js';

/** Priority: CLI --log-level > env LOG_LEVEL > config logging.level > default "info". */
export function resolveLogLevel(sources: {
  cli?: LogLevel;
  env?: string;
  config?: LogLevel;
}): string {
  return sources.cli ?? sources.env ?? sources.config ?? 'info';
}
