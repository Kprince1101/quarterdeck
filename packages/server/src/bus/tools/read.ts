import { z } from 'zod';
import {
  FILTER_OPS,
  IN_VALUES_MAX,
  READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX,
  buildReadQuery,
  filterOpsFor,
} from '../query.js';
import { READ_TABLES, READ_TABLE_NAMES } from '../tables.js';
import { defineBusTool } from '../tool.js';

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const describeTables = (): string =>
  Object.entries(READ_TABLES)
    .map(
      ([name, table]) =>
        `${name}(${Object.entries(table.columns)
          .map(([column, kind]) => `${column}:${kind}`)
          .join(', ')})`,
    )
    .join('\n');

const describeOps = (): string =>
  (['uuid', 'text', 'uuids', 'json'] as const)
    .map((kind) => `${kind}: ${filterOpsFor(kind).join(' ')}`)
    .join('; ');

export default defineBusTool({
  description: [
    "Read rows from this project's tables. No SQL: pick a table, columns, filters, order and limit.",
    'Filters are ANDed. Ops by column kind: int, numeric, bool and time take the uuid ops; ' +
      `${describeOps()}. \`in\` takes an array, \`is_null\`/\`not_null\` take no value.`,
    `Returns a JSON array of rows, newest first unless ordered, at most ${READ_LIMIT_MAX}.`,
    `Tables:\n${describeTables()}`,
  ].join('\n'),
  input: {
    table: z.enum(READ_TABLE_NAMES),
    columns: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('Columns to return; all readable columns when omitted.'),
    filters: z
      .array(
        z.object({
          column: z.string(),
          op: z.enum(FILTER_OPS).default('eq'),
          value: z
            .union([scalar, z.array(scalar).max(IN_VALUES_MAX)])
            .optional(),
        }),
      )
      .max(20)
      .optional(),
    order: z
      .array(
        z.object({
          column: z.string(),
          direction: z.enum(['asc', 'desc']).default('asc'),
        }),
      )
      .max(5)
      .optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(READ_LIMIT_MAX)
      .default(READ_LIMIT_DEFAULT),
  },
  run: async ({ store }, request) => {
    const { sql, params } = buildReadQuery(store.projectId, request);
    const { rows } = await store.db.query<{ row: unknown }>(sql, params);
    return JSON.stringify(rows.map(({ row }) => row));
  },
});
