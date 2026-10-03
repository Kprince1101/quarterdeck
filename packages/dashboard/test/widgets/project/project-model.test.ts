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
  SITE_ID,
  BUSY_BUILDER_ID,
  projectTables,
  ticket,
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

  it('describes live reviewers, retired count and idle crew', () => {
    const { panel } = buildProject(projectTables(), DECK_ID);
    expect(panel).toEqual({
      id: DECK_ID,
      slug: 'deck',
      name: 'Deck',
      isArchived: false,
      reviewer: 'tern',
      retiredCount: 1,
      idleAgentIds: [IDLE_BUILDER_ID, IDLE_REVIEWER_ID],
    });
  });

  it('never refreshes an idle agent that still holds an active ticket', () => {
    const tables = projectTables();
    const ids = () => buildProject(tables, DECK_ID).panel?.idleAgentIds;
    expect(ids()).not.toContain(BUSY_BUILDER_ID);
    tables.tickets = tables.tickets.map((row) => {
      if (row.assigneeId !== BUSY_BUILDER_ID) return row;
      return { ...row, status: 'done' };
    });
    expect(ids()).toEqual([IDLE_BUILDER_ID, BUSY_BUILDER_ID, IDLE_REVIEWER_ID]);
    tables.tickets.push(ticket(7, IDLE_REVIEWER_ID, 'assigned'));
    tables.tickets.push(ticket(8, IDLE_BUILDER_ID, 'bounced'));
    expect(ids()).toEqual([BUSY_BUILDER_ID]);
  });

  it('scopes everything to the chosen project', () => {
    const { panel } = buildProject(projectTables(), SITE_ID);
    expect(panel).toMatchObject({
      slug: 'site',
      reviewer: NO_REVIEWER,
      retiredCount: 1,
      idleAgentIds: [],
    });
    expect(buildProject(projectTables(), OLD_ID).panel?.isArchived).toBe(true);
  });
});
