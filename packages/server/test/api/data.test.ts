import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DATA_PAGE_SIZE,
  dataPageSchema,
  dataSummarySchema,
} from '../../src/intents/index.js';
import { STORE_TABLES } from '../../src/store/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const NOTES = 7;

describe('data intents', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let repoDir = '';

  const summary = async (project = 'deck') => {
    const res = await t.send('data.summary', { project });
    expect(res.status).toBe(200);
    return dataSummarySchema.parse(res.body['result']);
  };

  const page = async (body: Record<string, unknown>) => {
    const res = await t.send('data.rows', { project: 'deck', ...body });
    expect(res.status).toBe(200);
    return dataPageSchema.parse(res.body['result']);
  };

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'qd-data-repo-'));
    t = await startTestApi();
    await t.send('project.create', { project: 'deck', repoPath: repoDir });
    await t.send('project.create', { project: 'other' });
    for (let n = 1; n <= NOTES; n += 1) {
      await t.send('notebook.add', { project: 'deck', body: `note ${n}` });
    }
    await t.send('notebook.add', { project: 'other', body: 'elsewhere' });
  }, TIMEOUT);

  afterAll(async () => {
    await t.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it('counts every store table for the project alone', async () => {
    const { backend, tables } = await summary();
    expect(backend).toBe('pglite');
    expect(tables.map(({ table }) => table)).toEqual(STORE_TABLES);
    const rows = Object.fromEntries(
      tables.map(({ table, rows: count }) => [table, count]),
    );
    expect(rows).toMatchObject({ projects: 1, notebook: NOTES, turns: 0 });
    expect(rows['intents']).toBe(NOTES + 1);
  });

  it('does not record itself', async () => {
    const before = await summary();
    const res = await t.send('data.summary', { project: 'deck' });
    expect(res.body).toMatchObject({ status: 'applied', id: null });
    const after = await summary();
    expect(after.tables).toEqual(before.tables);
  });

  it('lists the paths on disk with whether each exists', async () => {
    const { paths } = await summary();
    const home = join(t.homeDir, '.quarterdeck');
    const byLabel = new Map(paths.map((path) => [path.label, path]));
    expect(byLabel.get('Postgres data')).toEqual({
      label: 'Postgres data',
      path: join(home, 'deck', 'pg'),
      kind: 'directory',
      scope: 'project',
      exists: true,
    });
    expect(byLabel.get('Turn files')).toMatchObject({
      path: join(home, 'deck', 'turns'),
      exists: false,
    });
    expect(byLabel.get('Ticket plugins')).toMatchObject({
      path: join(home, 'plugins'),
      scope: 'machine',
    });
    const repoRules = paths.filter((path) => path.scope === 'repo');
    expect(repoRules.length).toBeGreaterThan(0);
    repoRules.forEach((path) =>
      expect(path.path.startsWith(join(repoDir, '.quarterdeck'))).toBe(true),
    );
  });

  it('marks a path that appears later as existing', async () => {
    await mkdir(join(t.homeDir, '.quarterdeck', 'plugins'), {
      recursive: true,
    });
    const { paths } = await summary();
    expect(paths.find((path) => path.label === 'Ticket plugins')?.exists).toBe(
      true,
    );
  });

  it('pages rows newest first with column names', async () => {
    const first = await page({ table: 'notebook', limit: 3 });
    expect(first).toMatchObject({
      table: 'notebook',
      offset: 0,
      limit: 3,
      total: NOTES,
    });
    expect(first.columns).toContain('body');
    const body = first.columns.indexOf('body');
    expect(first.rows.map((row) => row[body])).toEqual([
      'note 7',
      'note 6',
      'note 5',
    ]);
    const last = await page({ table: 'notebook', offset: 6, limit: 3 });
    expect(last.rows.map((row) => row[body])).toEqual(['note 1']);
  });

  it('defaults the page size and serialises timestamps', async () => {
    const result = await page({ table: 'intents' });
    expect(result.limit).toBe(DATA_PAGE_SIZE);
    const created = result.columns.indexOf('created_at');
    expect(typeof result.rows[0]?.[created]).toBe('string');
  });

  it('shows an empty table with its columns', async () => {
    const result = await page({ table: 'cards' });
    expect(result.total).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.columns).toContain('question');
  });

  it('refuses a table it does not keep and a project that does not exist', async () => {
    const unknown = await t.send('data.rows', {
      project: 'deck',
      table: 'schema_migrations',
    });
    expect(unknown.status).toBe(404);
    const missing = await t.send('data.summary', { project: 'ghost' });
    expect(missing.status).toBe(404);
  });
});
