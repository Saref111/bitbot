/** MVP §13.6: TRACE/DEBUG/INFO/WARN/ERROR — the CLI flag, config, and pino level all draw from this set. */
export const logLevels = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

export interface CreateLoggerOptions {
  level?: string;
  logFilePath?: string;
}
