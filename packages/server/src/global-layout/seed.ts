import {
  DASHBOARD_LAYOUT,
  readGridLayout,
  type GridLayout,
} from '../layouts/index.js';
import type { Queryable } from '../store/index.js';

interface DashboardRow {
  spec: unknown;
  updatedAt: Date | string;
}

interface DatedLayout {
  spec: GridLayout;
  at: number;
}

const dashboardRows = async (db: Queryable): Promise<DashboardRow[]> => {
  const { rows } = await db.query<DashboardRow>(
    'select spec, updated_at as "updatedAt" from layouts where name = $1',
    [DASHBOARD_LAYOUT],
  );
  return rows;
};

const dated = (row: DashboardRow): DatedLayout[] => {
  const spec = readGridLayout(row.spec);
  if (spec === null) return [];
  return [{ spec, at: new Date(row.updatedAt).getTime() }];
};

export const newestDashboardLayout = async (
  dbs: readonly Queryable[],
): Promise<GridLayout | null> => {
  const rows = (await Promise.all(dbs.map(dashboardRows))).flat();
  const [newest] = rows.flatMap(dated).toSorted((a, b) => b.at - a.at);
  return newest?.spec ?? null;
};
