import { describe, expect, it } from 'vitest';
import { buildNotebook } from '../../../src/widgets/notebook/notebook-model.js';
import {
  ADD_ID,
  ENTRY_ID,
  OTHER_PROJECT_ID,
  PINNED_ID,
  RETIRE_ID,
  UPDATE_ID,
  entry,
  notebookTables,
  project,
  proposal,
} from './fixtures.js';

const MISSING_ID = '00000000-0000-4000-8000-0000000000ff';

describe('buildNotebook', () => {
  it('lists open proposals oldest first with the text each replaces', () => {
    const { proposals } = buildNotebook(notebookTables());
    expect(proposals.map(({ id }) => id)).toEqual([
      ADD_ID,
      UPDATE_ID,
      RETIRE_ID,
    ]);
    const [add, update, retire] = proposals;
    expect(add).toMatchObject({
      project: 'deck',
      opLabel: 'Add',
      display: 'text',
      body: 'Ask before deploying.',
      replaced: '',
      pinned: true,
      canEdit: true,
      entryMissing: false,
      hasRationale: false,
    });
    expect(update).toMatchObject({
      display: 'diff',
      body: 'Run the tests.\nUse npm ci.',
      replaced: 'Run the tests.\nUse npm.',
      canEdit: true,
    });
    expect(retire).toMatchObject({
      display: 'retired',
      body: '',
      replaced: 'Never merge.',
      canEdit: false,
      hasRationale: true,
      rationale: 'No longer true.',
    });
  });

  it('drops decided proposals', () => {
    const tables = notebookTables();
    tables.notebook_proposals = tables.notebook_proposals.map((row) => ({
      ...row,
      status: 'accepted',
    }));
    expect(buildNotebook(tables).proposals).toEqual([]);
  });

  it('flags a proposal whose entry is gone', () => {
    const tables = notebookTables();
    tables.notebook_proposals = [
      proposal(UPDATE_ID, 'update', { entryId: MISSING_ID, body: 'new' }),
    ];
    const [update] = buildNotebook(tables).proposals;
    expect(update).toMatchObject({ entryMissing: true, replaced: '' });
  });

  it('lists active entries pinned first, then oldest first', () => {
    const { entries } = buildNotebook(notebookTables());
    expect(entries).toEqual([
      { id: PINNED_ID, project: 'deck', body: 'Never merge.', pinned: true },
      {
        id: ENTRY_ID,
        project: 'deck',
        body: 'Run the tests.\nUse npm.',
        pinned: false,
      },
    ]);
  });

  it('skips rows whose project is not on the stream', () => {
    const tables = notebookTables();
    tables.notebook = [
      ...tables.notebook,
      entry(MISSING_ID, 'stray', { projectId: OTHER_PROJECT_ID }),
    ];
    tables.notebook_proposals = [
      proposal(ADD_ID, 'add', { projectId: OTHER_PROJECT_ID, body: 'stray' }),
    ];
    const model = buildNotebook(tables);
    expect(model.proposals).toEqual([]);
    expect(model.entries.map(({ id }) => id)).not.toContain(MISSING_ID);
  });

  it('names the project only when more than one is streamed', () => {
    const tables = notebookTables();
    expect(buildNotebook(tables).showProject).toBe(false);
    tables.projects = [...tables.projects, project(OTHER_PROJECT_ID, 'other')];
    expect(buildNotebook(tables).showProject).toBe(true);
  });
});
