import { z } from 'zod';
import { inProject } from './fields.js';

export const DATA_PAGE_SIZE = 25;
export const MAX_DATA_PAGE_SIZE = 100;

const TABLE_NAME = /^[a-z][a-z_]{0,62}$/;

export const dataPathKindSchema = z.enum(['directory', 'file', 'database']);

export const dataPathScopeSchema = z.enum(['project', 'repo', 'machine']);

export const dataPathSchema = z.object({
  label: z.string(),
  path: z.string(),
  kind: dataPathKindSchema,
  scope: dataPathScopeSchema,
  exists: z.boolean(),
});

export const tableCountSchema = z.object({
  table: z.string(),
  rows: z.int().nonnegative(),
});

export const dataSummarySchema = z.object({
  backend: z.enum(['pglite', 'postgres']),
  tables: z.array(tableCountSchema),
  paths: z.array(dataPathSchema),
});

export const dataPageSchema = z.object({
  table: z.string(),
  offset: z.int().nonnegative(),
  limit: z.int().positive(),
  total: z.int().nonnegative(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.json())),
});

export type DataPathKind = z.infer<typeof dataPathKindSchema>;
export type DataPathScope = z.infer<typeof dataPathScopeSchema>;
export type DataPathEntry = z.infer<typeof dataPathSchema>;
export type TableCount = z.infer<typeof tableCountSchema>;
export type DataSummary = z.infer<typeof dataSummarySchema>;
export type DataPage = z.infer<typeof dataPageSchema>;

export const DATA_INTENTS = {
  'data.summary': inProject({}),
  'data.rows': inProject({
    table: z.string().regex(TABLE_NAME),
    offset: z.int().nonnegative().default(0),
    limit: z.int().positive().max(MAX_DATA_PAGE_SIZE).default(DATA_PAGE_SIZE),
  }),
};

export type DataIntentName = keyof typeof DATA_INTENTS;
