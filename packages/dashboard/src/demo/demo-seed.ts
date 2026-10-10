import type { Forge } from '@quarterdeck/rules/forges';
import type { AuthReadResult } from '@quarterdeck/server/intents';
import type { GridLayout } from '@quarterdeck/server/layouts';
import type { SavedLayout } from '@quarterdeck/server/stream-schema';
import { DEMO_REPO_PATH } from './demo-reads.js';
import type { DemoWorld } from './demo-world.js';

export const DEMO_PROJECT = 'harbor';

export const DEMO_FORGE: Forge = 'github';

export const DEMO_AUTH: AuthReadResult['claude'] = {
  mode: 'subscription',
  source: 'default',
  missing: [],
  keySource: null,
  gateway: false,
};

export const DEMO_LAYOUT: GridLayout = {
  columns: 12,
  rows: 12,
  items: [
    { id: 'board-1', widget: 'board', x: 0, y: 0, w: 3, h: 6, hidden: false },
    {
      id: 'project-1',
      widget: 'project',
      tabs: ['agents'],
      x: 3,
      y: 0,
      w: 4,
      h: 6,
      hidden: false,
    },
    {
      id: 'planner-1',
      widget: 'planner',
      tabs: ['driver', 'notebook'],
      x: 7,
      y: 0,
      w: 5,
      h: 7,
      hidden: false,
    },
    {
      id: 'requests-1',
      widget: 'requests',
      x: 7,
      y: 7,
      w: 5,
      h: 5,
      hidden: false,
    },
    { id: 'cards-1', widget: 'cards', x: 0, y: 6, w: 3, h: 6, hidden: false },
    { id: 'events-1', widget: 'events', x: 3, y: 6, w: 4, h: 3, hidden: false },
    {
      id: 'usage-1',
      widget: 'usage',
      tabs: ['data'],
      x: 3,
      y: 9,
      w: 4,
      h: 3,
      hidden: false,
    },
    { id: 'rules-1', widget: 'rules', x: 0, y: 0, w: 6, h: 12, hidden: true },
  ],
};

export const DEMO_LIFECYCLE = `${JSON.stringify(
  { budget: { window: { capTokens: 2_000_000 } } },
  null,
  2,
)}\n`;

const NOTES = [
  {
    body: 'Every pull request needs a test for the unhappy path.',
    pinned: true,
  },
  {
    body: 'Booking dates are stored in UTC and shown in harbour time.',
    pinned: false,
  },
  {
    body: 'The berth map is read-only; changes go through bookings.',
    pinned: false,
  },
];

export const PLANNER_ASK =
  'Crews keep phoning to ask if their deposit went through. Can we tell them?';

export const seedProject = (world: DemoWorld): void => {
  const { store } = world;
  const at = store.now();
  store.put('projects', {
    id: store.projectId,
    slug: DEMO_PROJECT,
    name: 'Harbor',
    repoPath: DEMO_REPO_PATH,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    pausedAt: null,
    tracker: null,
    publishes: null,
  });
  store.emit('project.created', { payload: { slug: DEMO_PROJECT } });
  store.setLayout(DEMO_LAYOUT as SavedLayout['spec']);
  NOTES.forEach((note) => {
    store.put('notebook', {
      id: store.newId(),
      projectId: store.projectId,
      voyageId: null,
      authorId: null,
      body: note.body,
      pinned: note.pinned,
      createdAt: at,
      retiredAt: null,
    });
  });
};
