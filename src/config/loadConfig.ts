import { readFileSync } from 'node:fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { configSchema } from './schema.js';
import { ConfigError } from './errors.js';
import type { Config } from './types.js';

export function loadConfigFromFile(filePath: string): Config {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    throw new ConfigError([{ path: '', message: 'cannot read file' }], filePath);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    const message = error instanceof YAMLParseError ? error.message : String(error);
    throw new ConfigError([{ path: '', message: `invalid YAML: ${message}` }], filePath);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw ConfigError.fromZodError(result.error, filePath);
  }

  return result.data;
}
