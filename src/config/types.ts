import type { z } from 'zod';
import type { entryFilterSchema, gridConfigSchema, configSchema } from './schema.js';

export type EntryFilter = z.infer<typeof entryFilterSchema>;
export type GridConfig = z.infer<typeof gridConfigSchema>;
export type Config = z.infer<typeof configSchema>;
