import type { GridLayout } from '@quarterdeck/server/layouts';
import type {
  ProjectRow,
  SavedLayout,
  StreamMessage,
} from '@quarterdeck/server/stream-schema';
import { emptyTables } from '../../src/api/index.js';

export const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
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
  tracker: null,
  publishes: null,
});

export const savedLayout = (spec: unknown): SavedLayout => ({
  spec: spec as SavedLayout['spec'],
  updatedAt: AT,
});

export const snapshotWith = (
  layout: SavedLayout | null = null,
): StreamMessage => ({
  type: 'snapshot',
  cursor: 0,
  tables: { ...emptyTables(), projects: [projectRow()] },
  machine: { pausedAt: null },
  layout,
});

export const layoutFrame = (spec: unknown): StreamMessage => ({
  type: 'layout',
  layout: savedLayout(spec),
});
