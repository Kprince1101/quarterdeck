import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WIPE_ALL_CONFIRMATION } from '../../src/intents/index.js';
import { LAYOUT_PRESETS, parseGridLayout } from '../../src/layouts/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const BOARD_LAYOUT = {
  columns: 12,
  rows: 12,
  items: [
    { id: 'board', widget: 'board', x: 0, y: 0, w: 8, h: 6, hidden: false },
    {
      id: 'side',
      widget: 'planner',
      x: 8,
      y: 0,
      w: 4,
      h: 6,
      hidden: false,
      tabs: ['driver', 'notebook'],
    },
  ],
};

describe('workspace intents', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let repoDir = '';

  const machineRule = (file: string) =>
    join(t.homeDir, '.quarterdeck', `rules.local.${file}`);

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'qd-repo-'));
    t = await startTestApi();
  }, TIMEOUT);

  afterAll(async () => {
    await t.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  describe('projects', () => {
    it('creates a project once, with its name and repo', async () => {
      const res = await t.send('project.create', {
        project: 'deck',
        name: 'Deck',
        repoPath: repoDir,
      });
      expect(res.status).toBe(200);
      const store = await t.store('deck');
      const { rows } = await store.db.query(
        'select slug, name, repo_path from projects',
      );
      expect(rows).toEqual([
        { slug: 'deck', name: 'Deck', repo_path: repoDir },
      ]);
      expect((await t.send('project.create', { project: 'deck' })).status).toBe(
        409,
      );
    });

    it('lets only one of two concurrent creates win', async () => {
      const replies = await Promise.all([
        t.send('project.create', { project: 'race' }),
        t.send('project.create', { project: 'race' }),
      ]);
      expect(replies.map((reply) => reply.status).toSorted()).toEqual([
        200, 409,
      ]);
    });

    it('refuses a repoPath that is not a directory', async () => {
      const res = await t.send('project.create', {
        project: 'nowhere',
        repoPath: join(repoDir, 'missing'),
      });
      expect(res.status).toBe(400);
      expect(existsSync(join(t.homeDir, '.quarterdeck', 'nowhere'))).toBe(
        false,
      );
    });

    it('updates the name and clears the repo', async () => {
      await t.send('project.update', {
        project: 'deck',
        name: 'Deck 2',
        repoPath: null,
      });
      const store = await t.store('deck');
      const { rows } = await store.db.query(
        'select name, repo_path from projects',
      );
      expect(rows).toEqual([{ name: 'Deck 2', repo_path: null }]);
      await t.send('project.update', { project: 'deck', repoPath: repoDir });
    });

    it('archives a project once and unarchives it', async () => {
      const store = await t.store('deck');
      const archivedAt = async () => {
        const { rows } = await store.db.query<{ archived_at: unknown }>(
          'select archived_at from projects',
        );
        return rows[0]?.archived_at ?? null;
      };
      const res = await t.send('project.archive', {
        project: 'deck',
        archived: true,
      });
      expect(res).toMatchObject({
        status: 200,
        body: { status: 'applied', result: { archived: true } },
      });
      const first = await archivedAt();
      expect(first).not.toBeNull();
      await t.send('project.archive', { project: 'deck', archived: true });
      expect(await archivedAt()).toEqual(first);
      await t.send('project.archive', { project: 'deck', archived: false });
      expect(await archivedAt()).toBeNull();
      const { rows } = await store.db.query<{ kind: string }>(
        `select kind from events where kind = 'project.archive'`,
      );
      expect(rows).toHaveLength(3);
      expect(
        (await t.send('project.archive', { project: 'ghost', archived: true }))
          .status,
      ).toBe(404);
    });
  });

  describe('layouts', () => {
    it('saves, overwrites and deletes a layout by name', async () => {
      const saved = await t.send('layout.save', {
        project: 'deck',
        name: 'default',
        spec: BOARD_LAYOUT,
      });
      expect(saved.status).toBe(200);
      const shorter = { ...BOARD_LAYOUT, rows: 6 };
      await t.send('layout.save', {
        project: 'deck',
        name: 'default',
        spec: shorter,
      });
      const store = await t.store('deck');
      const { rows } = await store.db.query<{ spec: { rows: number } }>(
        'select spec from layouts',
      );
      expect(rows.map((row) => row.spec.rows)).toEqual([6]);
      expect(
        (await t.send('layout.delete', { project: 'deck', name: 'default' }))
          .status,
      ).toBe(200);
      expect(
        (await t.send('layout.delete', { project: 'deck', name: 'default' }))
          .status,
      ).toBe(404);
    });

    it('refuses duplicate widget ids', async () => {
      const [item] = BOARD_LAYOUT.items;
      const res = await t.send('layout.save', {
        project: 'deck',
        name: 'dupes',
        spec: { ...BOARD_LAYOUT, items: [item, { ...item, x: 8 }] },
      });
      expect(res.status).toBe(400);
    });

    it('refuses a layout the grid could not show', async () => {
      const [board, side] = BOARD_LAYOUT.items;
      const overlapping = await t.send('layout.save', {
        project: 'deck',
        name: 'bad',
        spec: { ...BOARD_LAYOUT, items: [board, { ...side, x: 4 }] },
      });
      expect(overlapping.status).toBe(400);
      const outside = await t.send('layout.save', {
        project: 'deck',
        name: 'bad',
        spec: { ...BOARD_LAYOUT, rows: 4 },
      });
      expect(outside.status).toBe(400);
    });

    it('resets a layout to a shipped preset', async () => {
      await t.send('layout.save', {
        project: 'deck',
        name: 'dashboard',
        spec: BOARD_LAYOUT,
      });
      const res = await t.send('layout.reset', {
        project: 'deck',
        name: 'dashboard',
        preset: 'ops',
      });
      expect(res).toMatchObject({
        status: 200,
        body: { result: { name: 'dashboard', preset: 'ops' } },
      });
      const store = await t.store('deck');
      const { rows } = await store.db.query<{ spec: unknown }>(
        "select spec from layouts where name = 'dashboard'",
      );
      expect(rows.map((row) => parseGridLayout(row.spec))).toEqual([
        LAYOUT_PRESETS.ops,
      ]);
      const unknown = await t.send('layout.reset', {
        project: 'deck',
        name: 'dashboard',
        preset: 'cockpit',
      });
      expect(unknown.status).toBe(400);
    });
  });

  describe('rules', () => {
    it('writes a machine override that passes the schema', async () => {
      const content = JSON.stringify({ stuckAfterMinutes: 45 });
      const res = await t.send('rules.write', {
        scope: 'machine',
        name: 'lifecycle',
        content,
      });
      expect(res).toMatchObject({
        status: 200,
        body: { id: null, result: { path: machineRule('lifecycle.json') } },
      });
      expect(await readFile(machineRule('lifecycle.json'), 'utf8')).toBe(
        content,
      );
    });

    it('refuses an override the loader would reject, naming the real file', async () => {
      const broken = await t.send('rules.write', {
        scope: 'machine',
        name: 'naming',
        content: '{"names": []}',
      });
      expect(broken.status).toBe(400);
      expect(broken.body.error).toContain(machineRule('naming.json'));
      expect(existsSync(machineRule('naming.json'))).toBe(false);
      const unparsable = await t.send('rules.write', {
        scope: 'machine',
        name: 'models',
        content: '{',
      });
      expect(unparsable.status).toBe(400);
    });

    it('writes and resets a project override in the repo', async () => {
      const res = await t.send('rules.write', {
        scope: 'project',
        project: 'deck',
        name: 'reviewer',
        content: '# Reviewer\n\nBe kind.',
      });
      const path = join(repoDir, '.quarterdeck', 'rules.local.reviewer.md');
      expect(res.body.result).toEqual({ path });
      expect(typeof res.body.id).toBe('string');
      const reset = await t.send('rules.reset', {
        scope: 'project',
        project: 'deck',
        name: 'reviewer',
      });
      expect(reset.body.result).toEqual({ path, removed: true });
      expect(existsSync(path)).toBe(false);
      const machine = await t.send('rules.reset', {
        scope: 'machine',
        name: 'reviewer',
      });
      expect(machine.body.result).toMatchObject({ removed: false });
    });
  });

  describe('wipe', () => {
    it('needs the slug repeated before wiping a project', async () => {
      await t.send('project.create', { project: 'scratch' });
      const mismatch = await t.send('wipe.project', {
        project: 'scratch',
        confirm: 'deck',
      });
      expect(mismatch.status).toBe(400);
      const res = await t.send('wipe.project', {
        project: 'scratch',
        confirm: 'scratch',
      });
      expect(res.body.result).toEqual({ wiped: ['scratch'] });
      expect(existsSync(join(t.homeDir, '.quarterdeck', 'scratch'))).toBe(
        false,
      );
      expect(
        (await t.send('notebook.add', { project: 'scratch', body: 'hi' }))
          .status,
      ).toBe(404);
    });

    it('wipes every project but leaves machine rules alone', async () => {
      await t.send('project.create', { project: 'other' });
      const refused = await t.send('wipe.all', { confirm: 'yes' });
      expect(refused.status).toBe(400);
      const res = await t.send('wipe.all', { confirm: WIPE_ALL_CONFIRMATION });
      expect(res.body.result).toEqual({ wiped: ['deck', 'other', 'race'] });
      expect(existsSync(join(t.homeDir, '.quarterdeck', 'deck'))).toBe(false);
      expect(existsSync(machineRule('lifecycle.json'))).toBe(true);
    });
  });
});
