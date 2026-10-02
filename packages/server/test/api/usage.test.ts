import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { usageReadResultSchema } from '../../src/intents/index.js';
import type { Store } from '../../src/store/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const project = 'usage';
const other = 'elsewhere';

const writeLifecycle = async (dir: string, layer: unknown) => {
  await mkdir(join(dir, '.quarterdeck'), { recursive: true });
  await writeFile(
    join(dir, '.quarterdeck', 'rules.local.lifecycle.json'),
    JSON.stringify(layer),
  );
};

const capLayer = (capTokens: number) => ({
  budget: { window: { capTokens } },
});

describe('usage.read', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let store: Store;
  let repoDir: string;

  const insertAgent = async (target: Store, name: string): Promise<string> => {
    const { rows } = await target.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, $2, 'builder', 'idle') returning id`,
      [target.projectId, name],
    );
    const [row] = rows;
    if (!row) throw new Error('no agent row');
    return row.id;
  };

  const insertTurns = async (
    target: Store,
    agentId: string,
    turns: { tokens: number; endedHoursAgo: number | null }[],
  ) => {
    for (const [index, turn] of turns.entries()) {
      await target.db.query(
        `insert into turns
           (agent_id, seq, prompt, input_tokens, output_tokens, ended_at)
         values ($1, $2, 'go', $3, 1,
           case when $4::float8 is null then null
                else now() - make_interval(secs => $4::float8 * 3600) end)`,
        [agentId, index + 1, turn.tokens - 1, turn.endedHoursAgo],
      );
    }
  };

  const read = async (slug = project) => {
    const res = await t.send('usage.read', { project: slug });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent: 'usage.read',
      status: 'applied',
      id: null,
    });
    return usageReadResultSchema.parse(res.body.result);
  };

  beforeAll(async () => {
    t = await startTestApi();
    repoDir = await mkdtemp(join(tmpdir(), 'qd-usage-repo-'));
    await t.send('project.create', { project });
    await t.send('project.create', { project: other });
    store = await t.store(project);
    const kite = await insertAgent(store, 'kite');
    const wren = await insertAgent(store, 'wren');
    await insertTurns(
      store,
      kite,
      Array.from({ length: 25 }, () => ({ tokens: 10, endedHoursAgo: 1 })),
    );
    await insertTurns(store, wren, [
      { tokens: 30, endedHoursAgo: 4.9 },
      { tokens: 5000, endedHoursAgo: 5.1 },
      { tokens: 700, endedHoursAgo: null },
    ]);
    const elsewhere = await t.store(other);
    await insertTurns(elsewhere, await insertAgent(elsewhere, 'kite'), [
      { tokens: 900, endedHoursAgo: 1 },
    ]);
  }, TIMEOUT);

  afterEach(async () => {
    await rm(join(t.homeDir, '.quarterdeck', 'rules.local.lifecycle.json'), {
      force: true,
    });
    await rm(join(repoDir, '.quarterdeck'), { recursive: true, force: true });
  });

  afterAll(async () => {
    await t.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it('sums every ended turn of the project in the window, with no cap by default', async () => {
    expect(await read()).toEqual({
      windowHours: 5,
      usedTokens: 280,
      capTokens: null,
      percent: null,
    });
  });

  it('reads the cap from the machine layer and gives the percent', async () => {
    await writeLifecycle(t.homeDir, capLayer(400));

    expect(await read()).toEqual({
      windowHours: 5,
      usedTokens: 280,
      capTokens: 400,
      percent: 70,
    });
  });

  it('applies the project repo layer the way the hold does', async () => {
    await writeLifecycle(t.homeDir, capLayer(1000));
    await writeLifecycle(repoDir, {
      budget: { window: { capTokens: 350, hours: 6 } },
    });
    await t.send('project.update', { project, repoPath: repoDir });

    expect(await read()).toEqual({
      windowHours: 6,
      usedTokens: 5280,
      capTokens: 350,
      percent: (5280 / 350) * 100,
    });

    await t.send('project.update', { project, repoPath: null });
  });

  it('counts only the asked project', async () => {
    expect((await read(other)).usedTokens).toBe(900);
  });

  it('records nothing', async () => {
    await read();
    const { rows } = await store.db.query<{ intents: number; events: number }>(
      `select
         (select count(*)::int from intents where kind = 'usage.read') as intents,
         (select count(*)::int from events where kind = 'usage.read') as events`,
    );
    expect(rows[0]).toEqual({ intents: 0, events: 0 });
  });

  it('refuses invalid rules with 409', async () => {
    await writeLifecycle(t.homeDir, { budget: { window: { hours: 0 } } });

    const res = await t.send('usage.read', { project });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('rules.local.lifecycle.json');
  });

  it('answers 404 for an unknown project', async () => {
    const res = await t.send('usage.read', { project: 'nowhere' });

    expect(res.status).toBe(404);
  });
});
