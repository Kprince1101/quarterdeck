import { describe, expect, it } from 'vitest';
import { emptyTables } from '../../../src/api/index.js';
import {
  NO_REVIEWER,
  buildProject,
} from '../../../src/widgets/project/project-model.js';
import {
  DECK_ID,
  IDLE_BUILDER_ID,
  IDLE_REVIEWER_ID,
  OLD_ID,
  ROUND_ID,
  SITE_ID,
  projectTables,
  round,
} from './fixtures.js';

describe('project model', () => {
  it('has no panel without projects', () => {
    expect(buildProject(emptyTables(), '')).toEqual({
      options: [],
      chosenId: '',
      panel: null,
    });
  });

  it('lists projects by name with archived ones last, and picks the first', () => {
    const model = buildProject(projectTables(), '');
    expect(model.options).toEqual([
      { value: DECK_ID, label: 'Deck' },
      { value: SITE_ID, label: 'Site' },
      { value: OLD_ID, label: 'Archive Me (archived)' },
    ]);
    expect(model.chosenId).toBe(DECK_ID);
  });

  it('falls back to the first project when the chosen one is gone', () => {
    const model = buildProject(projectTables(), 'gone');
    expect(model.chosenId).toBe(DECK_ID);
  });

  it('describes the open round, live reviewers, retired count and idle crew', () => {
    const { panel } = buildProject(projectTables(), DECK_ID);
    expect(panel).toEqual({
      id: DECK_ID,
      slug: 'deck',
      name: 'Deck',
      isArchived: false,
      round: {
        id: ROUND_ID,
        label: 'Round 2 · active',
        goal: 'Ship the project widget',
      },
      reviewer: 'tern',
      retiredCount: 1,
      idleAgentIds: [IDLE_BUILDER_ID, IDLE_REVIEWER_ID],
    });
  });

  it('takes the newest unended round, planning included', () => {
    const tables = projectTables();
    tables.rounds.push(
      round('00000000-0000-4000-8000-0000000000b3', 3, { status: 'planning' }),
    );
    expect(buildProject(tables, DECK_ID).panel?.round?.label).toBe(
      'Round 3 · planning',
    );
  });

  it('scopes everything to the chosen project', () => {
    const { panel } = buildProject(projectTables(), SITE_ID);
    expect(panel).toMatchObject({
      slug: 'site',
      round: null,
      reviewer: NO_REVIEWER,
      retiredCount: 1,
      idleAgentIds: [],
    });
    expect(buildProject(projectTables(), OLD_ID).panel?.isArchived).toBe(true);
  });
});
