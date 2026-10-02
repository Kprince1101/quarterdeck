import type { GridLayout } from '@quarterdeck/server/layouts';
import type {
  LayoutRow,
  ProjectRow,
  StreamMessage,
} from '@quarterdeck/server/stream-schema';
import { emptyTables } from '../../src/api/index.js';
import { DASHBOARD_LAYOUT } from '../../src/layouts/constants.js';

export const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const LAYOUT_ID = '00000000-0000-4000-8000-000000000002';
const AT = '2026-10-01T12:00:00.000Z';

export const STARTER_LAYOUT: GridLayout = {
  columns: 12,
  rows: 12,
  items: [
    {
      id: 'events-1',
      widget: 'events',
      x: 0,
      y: 0,
      w: 8,
      h: 12,
      hidden: false,
    },
    {
      id: 'tables-1',
      widget: 'tables',
      x: 8,
      y: 0,
      w: 4,
      h: 12,
      hidden: false,
    },
  ],
};

export const projectRow = (slug = 'deck'): ProjectRow => ({
  id: PROJECT_ID,
  slug,
  name: slug,
  repoPath: null,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  pausedAt: null,
});

export const layoutRow = (
  spec: unknown,
  name: string = DASHBOARD_LAYOUT,
): LayoutRow => ({
  id: LAYOUT_ID,
  projectId: PROJECT_ID,
  name,
  spec: spec as LayoutRow['spec'],
  createdAt: AT,
  updatedAt: AT,
});

export const snapshotWith = (...layouts: LayoutRow[]): StreamMessage => ({
  type: 'snapshot',
  cursor: 0,
  tables: { ...emptyTables(), projects: [projectRow()], layouts },
  machine: { pausedAt: null },
});

export const layoutChange = (row: LayoutRow): StreamMessage => ({
  type: 'change',
  table: 'layouts',
  op: 'update',
  id: row.id,
  row,
});
