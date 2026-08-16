import type { ZodError } from 'zod';
import { ConfigIssue } from './types.js';

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[], context: string) {
    const summary = issues
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      .join('; ');
    super(`Invalid config (${context}): ${summary}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }

  static fromZodError(error: ZodError, context: string): ConfigError {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return new ConfigError(issues, context);
  }
}
