import {
  READ_TABLES,
  type ColumnKind,
  type ReadTable,
  type ReadTableName,
} from './tables.js';
import { BusToolError } from './tool.js';

export const FILTER_OPS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'contains',
  'is_null',
  'not_null',
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

export type FilterScalar = string | number | boolean;

export interface ReadFilter {
  column: string;
  op: FilterOp;
  value?: FilterScalar | FilterScalar[] | undefined;
}

export interface ReadOrder {
  column: string;
  direction: 'asc' | 'desc';
}

export interface ReadRequest {
  table: ReadTableName;
  columns?: string[] | undefined;
  filters?: ReadFilter[] | undefined;
  order?: ReadOrder[] | undefined;
  limit: number;
}

export interface ReadQuery {
  sql: string;
  params: unknown[];
}

export const READ_LIMIT_DEFAULT = 50;
export const READ_LIMIT_MAX = 200;
export const IN_VALUES_MAX = 100;
export const READ_REPLY_MAX_BYTES = 100_000;

const PG_TYPES: Record<ColumnKind, string> = {
  uuid: 'uuid',
  uuids: 'uuid[]',
  text: 'text',
  int: 'int8',
  numeric: 'numeric',
  bool: 'boolean',
  time: 'timestamptz',
  json: 'jsonb',
};

const NULL_OPS: readonly FilterOp[] = ['is_null', 'not_null'];
const SCALAR_OPS: readonly FilterOp[] = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  ...NULL_OPS,
];

const OPS_BY_KIND: Record<ColumnKind, readonly FilterOp[]> = {
  uuid: SCALAR_OPS,
  uuids: ['contains', ...NULL_OPS],
  text: [...SCALAR_OPS, 'contains'],
  int: SCALAR_OPS,
  numeric: SCALAR_OPS,
  bool: SCALAR_OPS,
  time: SCALAR_OPS,
  json: NULL_OPS,
};

const COMPARISONS: Partial<Record<FilterOp, string>> = {
  eq: '=',
  neq: 'is distinct from',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

const UNORDERABLE: readonly ColumnKind[] = ['uuids', 'json'];

export const filterOpsFor = (kind: ColumnKind): readonly FilterOp[] =>
  OPS_BY_KIND[kind];

const quote = (column: string): string => `"${column}"`;

const escapeLike = (value: string): string =>
  value.replaceAll(/[\\%_]/g, '\\$&');

const columnKind = (
  name: ReadTableName,
  table: ReadTable,
  column: string,
): ColumnKind => {
  const kind = Object.hasOwn(table.columns, column) && table.columns[column];
  if (!kind)
    throw new BusToolError(
      `${name} has no readable column ${column}; readable: ${Object.keys(table.columns).join(', ')}`,
    );
  return kind;
};

const scalarValue = (filter: ReadFilter): FilterScalar => {
  const { value } = filter;
  if (value === undefined || Array.isArray(value))
    throw new BusToolError(
      `filter ${filter.column} ${filter.op} needs a single value`,
    );
  return value;
};

const listValue = (filter: ReadFilter): FilterScalar[] => {
  const { value } = filter;
  if (!Array.isArray(value) || value.length === 0)
    throw new BusToolError(
      `filter ${filter.column} in needs a non-empty array value`,
    );
  if (value.length > IN_VALUES_MAX)
    throw new BusToolError(
      `filter ${filter.column} in takes at most ${IN_VALUES_MAX} values`,
    );
  return value;
};

const textValue = (filter: ReadFilter): string => {
  const value = scalarValue(filter);
  if (typeof value !== 'string')
    throw new BusToolError(
      `filter ${filter.column} contains needs a string value`,
    );
  return value;
};

type Bind = (value: unknown, type: string) => string;

const filterClause = (
  filter: ReadFilter,
  kind: ColumnKind,
  bind: Bind,
): string => {
  const column = quote(filter.column);
  const type = PG_TYPES[kind];
  const comparison = COMPARISONS[filter.op];
  if (comparison !== undefined)
    return `${column} ${comparison} ${bind(scalarValue(filter), type)}`;
  if (filter.op === 'in')
    return `${column} = any(${bind(listValue(filter), `${type}[]`)})`;
  if (filter.op === 'contains' && kind === 'uuids')
    return `${bind(textValue(filter), 'uuid')} = any(${column})`;
  if (filter.op === 'contains')
    return `${column} ilike ${bind(`%${escapeLike(textValue(filter))}%`, 'text')}`;
  if (filter.value !== undefined)
    throw new BusToolError(
      `filter ${filter.column} ${filter.op} takes no value`,
    );
  if (filter.op === 'is_null') return `${column} is null`;
  return `${column} is not null`;
};

const selectList = (
  name: ReadTableName,
  table: ReadTable,
  columns: string[] | undefined,
): string => {
  const chosen = columns ?? Object.keys(table.columns);
  const repeated = chosen.find((column, i) => chosen.indexOf(column) !== i);
  if (repeated !== undefined)
    throw new BusToolError(`column ${repeated} is listed twice`);
  const pairs = chosen.map((column) => {
    columnKind(name, table, column);
    return `'${column}', ${quote(column)}`;
  });
  return `json_build_object(${pairs.join(', ')})`;
};

const orderList = (
  name: ReadTableName,
  table: ReadTable,
  order: ReadOrder[],
): string => {
  const terms = order.map(({ column, direction }) => {
    const kind = columnKind(name, table, column);
    if (UNORDERABLE.includes(kind))
      throw new BusToolError(`${name}.${column} cannot be ordered by`);
    return `${quote(column)} ${direction}`;
  });
  return [...terms, table.order].join(', ');
};

export const buildReadQuery = (
  projectId: string,
  request: ReadRequest,
): ReadQuery => {
  const name = request.table;
  if (!Object.hasOwn(READ_TABLES, name))
    throw new BusToolError(`${String(name)} is not a readable table`);
  const table: ReadTable = READ_TABLES[name];
  if (!Number.isInteger(request.limit) || request.limit < 1)
    throw new BusToolError('limit must be a positive integer');
  const params: unknown[] = [projectId];
  const bind: Bind = (value, type) => {
    params.push(value);
    return `$${params.length}::${type}`;
  };
  const select = selectList(name, table, request.columns);
  const where = [table.scope];
  for (const filter of request.filters ?? []) {
    const kind = columnKind(name, table, filter.column);
    if (!OPS_BY_KIND[kind].includes(filter.op))
      throw new BusToolError(
        `${name}.${filter.column} takes ${OPS_BY_KIND[kind].join(', ')}, not ${filter.op}`,
      );
    where.push(filterClause(filter, kind, bind));
  }
  const order = orderList(name, table, request.order ?? []);
  const limit = bind(Math.min(request.limit, READ_LIMIT_MAX), 'int8');
  return {
    sql: `select ${select} as row from ${quote(name)}
     where ${where.map((clause) => `(${clause})`).join(' and ')}
     order by ${order}
     limit ${limit}`,
    params,
  };
};
