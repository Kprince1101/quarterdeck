import type {
  NotebookProposalRow,
  NotebookRow,
  ProjectRow,
  SnapshotTables,
} from '@quarterdeck/server/stream-schema';
import { emptyTables } from '../../../src/api/index.js';

export const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
export const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000002';
export const ENTRY_ID = '00000000-0000-4000-8000-0000000000e1';
export const PINNED_ID = '00000000-0000-4000-8000-0000000000e2';
export const RETIRED_ID = '00000000-0000-4000-8000-0000000000e3';
export const ADD_ID = '00000000-0000-4000-8000-0000000000a1';
export const UPDATE_ID = '00000000-0000-4000-8000-0000000000a2';
export const RETIRE_ID = '00000000-0000-4000-8000-0000000000a3';

const AT = '2026-10-01T12:00:00.000Z';

const at = (second: number): string =>
  `2026-10-01T12:00:${String(second).padStart(2, '0')}.000Z`;

export const project = (
  id: string,
  slug: string,
  overrides: Partial<ProjectRow> = {},
): ProjectRow => ({
  id,
  slug,
  name: slug,
  repoPath: null,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  ...overrides,
});

export const entry = (
  id: string,
  body: string,
  overrides: Partial<NotebookRow> = {},
): NotebookRow => ({
  id,
  projectId: PROJECT_ID,
  roundId: null,
  authorId: null,
  body,
  pinned: false,
  createdAt: AT,
  retiredAt: null,
  ...overrides,
});

export const proposal = (
  id: string,
  op: NotebookProposalRow['op'],
  overrides: Partial<NotebookProposalRow> = {},
): NotebookProposalRow => ({
  id,
  projectId: PROJECT_ID,
  roundId: null,
  agentId: null,
  op,
  entryId: null,
  body: null,
  pinned: false,
  rationale: '',
  status: 'open',
  createdAt: AT,
  decidedAt: null,
  ...overrides,
});

export const notebookTables = (): SnapshotTables => ({
  ...emptyTables(),
  projects: [project(PROJECT_ID, 'deck')],
  notebook: [
    entry(ENTRY_ID, 'Run the tests.\nUse npm.', { createdAt: at(1) }),
    entry(PINNED_ID, 'Never merge.', { pinned: true, createdAt: at(2) }),
    entry(RETIRED_ID, 'Old habit.', { retiredAt: at(3), createdAt: at(3) }),
  ],
  notebook_proposals: [
    proposal(RETIRE_ID, 'retire', {
      entryId: PINNED_ID,
      rationale: 'No longer true.',
      createdAt: at(6),
    }),
    proposal(ADD_ID, 'add', {
      body: 'Ask before deploying.',
      pinned: true,
      createdAt: at(4),
    }),
    proposal(UPDATE_ID, 'update', {
      entryId: ENTRY_ID,
      body: 'Run the tests.\nUse npm ci.',
      createdAt: at(5),
    }),
  ],
});
