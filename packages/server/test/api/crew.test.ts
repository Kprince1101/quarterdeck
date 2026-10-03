import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS_CHANNEL, type Store } from '../../src/store/index.js';
import { TIMEOUT, intentRow, startTestApi, type TestApi } from './harness.js';

const project = 'crew';

describe('crew intents are recorded or applied', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let store: Store;

  const insertAgent = async (status: string) => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, $2, 'builder', $3) returning id`,
      [store.projectId, `otter-${crypto.randomUUID()}`, status],
    );
    return rows[0]?.id;
  };

  beforeAll(async () => {
    t = await startTestApi();
    await t.send('project.create', { project });
    store = await t.store(project);
  }, TIMEOUT);

  afterAll(async () => {
    await t.close();
  });

  it.each([
    ['voyage.start', { goal: 'ship QD6' }],
    ['planner.message', { text: 'split the API ticket' }],
    ['planner.new', {}],
  ])('%s is stored as a pending intent', async (name, body) => {
    const res = await t.send(name, { project, ...body });
    expect(res).toMatchObject({
      status: 202,
      body: { intent: name, status: 'pending', result: null },
    });
    expect(await intentRow(store, res.body.id)).toEqual({
      kind: name,
      status: 'pending',
      settled: false,
      events: 1,
    });
  });

  it('notifies the events channel with the intent kind', async () => {
    const kinds: string[] = [];
    const unlisten = await store.db.listen(EVENTS_CHANNEL, (payload) => {
      kinds.push((JSON.parse(payload) as { kind: string }).kind);
    });
    await t.send('pause.set', { project, paused: false });
    await unlisten();
    expect(kinds).toEqual(['pause.set']);
  });

  it.each([
    ['voyage.end', 1],
    ['voyage.kill', 2],
  ])('%s checks the voyage exists and is still open', async (name, number) => {
    const missing = await t.send(name, {
      project,
      voyageId: crypto.randomUUID(),
    });
    expect(missing.status).toBe(404);
    const { rows } = await store.db.query<{ id: string; status: string }>(
      `insert into voyages (project_id, number, status)
       values ($1, $2, 'ended'), ($1, $3, 'active') returning id, status`,
      [store.projectId, number * 10, number * 10 + 1],
    );
    const [ended, open] = rows;
    const refused = await t.send(name, { project, voyageId: ended?.id });
    expect(refused.status).toBe(409);
    const queued = await t.send(name, { project, voyageId: open?.id });
    expect(queued).toMatchObject({
      status: 202,
      body: { intent: name, status: 'pending' },
    });
  });

  it.each(['agent.end', 'agent.kill'])(
    '%s queues for a live agent',
    async (name) => {
      const agentId = await insertAgent('working');
      const res = await t.send(name, { project, agentId });
      expect(res.status).toBe(202);
    },
  );

  it.each(['ended', 'killed', 'stuck'])(
    'agent.retire queues for an %s agent so its name and worktree are freed',
    async (status) => {
      const agentId = await insertAgent(status);
      const res = await t.send('agent.retire', { project, agentId });
      expect(res.status).toBe(202);
    },
  );

  it.each(['idle', 'working', 'killed', 'ended'])(
    'agent.reset queues for an %s agent so its next launch is fresh',
    async (status) => {
      const agentId = await insertAgent(status);
      const res = await t.send('agent.reset', { project, agentId });
      expect(res.status).toBe(202);
      expect(await intentRow(store, res.body.id)).toMatchObject({
        kind: 'agent.reset',
        status: 'pending',
      });
    },
  );

  it('refuses agent.reset for a retired agent', async () => {
    const agentId = await insertAgent('retired');
    const res = await t.send('agent.reset', { project, agentId });
    expect(res).toMatchObject({
      status: 409,
      body: { error: `agent ${agentId} is already retired` },
    });
  });

  it.each([
    ['agent.kill', {}],
    ['agent.message', { text: 'hi' }],
  ])('%s refuses an agent that has ended', async (name, extra) => {
    const agentId = await insertAgent('ended');
    const res = await t.send(name, { project, agentId, ...extra });
    expect(res.status).toBe(409);
  });

  it('refuses agent.pause for an agent that has ended and changes nothing', async () => {
    const agentId = await insertAgent('ended');
    const res = await t.send('agent.pause', { project, agentId });
    expect(res.status).toBe(409);
    const { rows } = await store.db.query<{ status: string }>(
      'select status from agents where id = $1',
      [agentId],
    );
    expect(rows).toEqual([{ status: 'ended' }]);
  });

  it('refuses lifecycle intents for an agent that is gone and writes nothing', async () => {
    const agentId = await insertAgent('retired');
    const res = await t.send('agent.retire', { project, agentId });
    expect(res).toMatchObject({
      status: 409,
      body: { error: `agent ${agentId} is already retired` },
    });
    const { rows } = await store.db.query<{ count: number }>(
      `select count(*)::int as count from intents
       where input ->> 'agentId' = $1`,
      [agentId],
    );
    expect(rows).toEqual([{ count: 0 }]);
    const unknown = await t.send('agent.message', {
      project,
      agentId: crypto.randomUUID(),
      text: 'hello',
    });
    expect(unknown.status).toBe(404);
  });

  it('pauses and unpauses the project at once', async () => {
    const pausedAt = async () => {
      const { rows } = await store.db.query<{ pausedAt: Date | null }>(
        'select paused_at as "pausedAt" from projects where id = $1',
        [store.projectId],
      );
      return rows[0]?.pausedAt;
    };

    const paused = await t.send('pause.set', { project, paused: true });
    expect(paused).toMatchObject({
      status: 200,
      body: {
        intent: 'pause.set',
        status: 'applied',
        result: { paused: true, pausedAt: expect.any(String) },
      },
    });
    const first = await pausedAt();
    expect(first).toBeInstanceOf(Date);
    expect(await intentRow(store, paused.body.id)).toEqual({
      kind: 'pause.set',
      status: 'applied',
      settled: true,
      events: 1,
    });
    await t.send('pause.set', { project, paused: true });
    expect(await pausedAt()).toEqual(first);

    const unpaused = await t.send('pause.set', { project, paused: false });
    expect(unpaused.body.result).toEqual({ paused: false, pausedAt: null });
    expect(await pausedAt()).toBeNull();
  });

  it('pauses every project and the machine with pause.all', async () => {
    await t.send('project.create', { project: 'crew2' });
    const other = await t.store('crew2');
    const file = join(t.api.stores.dataHome, 'pause.json');
    const recorded = async (s: Store) => {
      const { rows } = await s.db.query<{ input: unknown; status: string }>(
        `select input, status from intents
           where project_id = $1 and kind = 'pause.all' order by created_at`,
        [s.projectId],
      );
      return rows;
    };

    const paused = await t.send('pause.all', { paused: true });

    expect(paused).toMatchObject({
      status: 200,
      body: {
        intent: 'pause.all',
        status: 'applied',
        id: null,
        result: { paused: true, projects: ['crew', 'crew2'], failed: [] },
      },
    });
    expect(existsSync(file)).toBe(true);
    expect(await recorded(store)).toEqual([
      { input: { project, paused: true }, status: 'applied' },
    ]);
    expect(await recorded(other)).toEqual([
      { input: { project: 'crew2', paused: true }, status: 'applied' },
    ]);

    const unpaused = await t.send('pause.all', { paused: false });
    expect(unpaused.status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect(await recorded(other)).toHaveLength(2);
  });

  it('records pause.all in every project it can open and lists the rest', async () => {
    const pg = join(t.api.stores.dataHome, 'locked', 'pg');
    await mkdir(pg, { recursive: true });
    await writeFile(join(pg, 'PG_VERSION'), '17');
    await writeFile(`${pg}.lock`, String(process.ppid));
    try {
      const paused = await t.send('pause.all', { paused: true });

      expect(paused.status).toBe(200);
      expect(paused.body.result).toEqual({
        paused: true,
        projects: ['crew', 'crew2'],
        failed: [
          { project: 'locked', error: expect.stringContaining('already open') },
        ],
      });
      expect(existsSync(join(t.api.stores.dataHome, 'pause.json'))).toBe(true);
    } finally {
      await t.send('pause.all', { paused: false });
      await rm(join(t.api.stores.dataHome, 'locked'), {
        recursive: true,
        force: true,
      });
    }
  });

  it('pauses a live agent and resumes it to idle, or working mid-turn', async () => {
    const status = async (agentId: string | undefined) => {
      const { rows } = await store.db.query<{ status: string }>(
        'select status from agents where id = $1',
        [agentId],
      );
      return rows[0]?.status;
    };
    const idle = await insertAgent('idle');
    const working = await insertAgent('working');
    await store.db.query(
      `insert into turns (agent_id, seq, prompt) values ($1, 1, 'go')`,
      [working],
    );

    const paused = await t.send('agent.pause', { project, agentId: idle });
    expect(paused).toMatchObject({
      status: 200,
      body: { result: { agentId: idle, status: 'paused' } },
    });
    expect(await status(idle)).toBe('paused');
    expect(
      (await t.send('agent.pause', { project, agentId: idle })).body,
    ).toEqual({ error: `agent ${idle} is already paused` });
    await t.send('agent.pause', { project, agentId: working });

    const resumed = await t.send('agent.resume', { project, agentId: idle });
    expect(resumed.body.result).toEqual({ agentId: idle, status: 'idle' });
    await t.send('agent.resume', { project, agentId: working });
    expect(await status(working)).toBe('working');

    const again = await t.send('agent.resume', { project, agentId: idle });
    expect(again).toMatchObject({
      status: 409,
      body: { error: `agent ${idle} is not paused, it is idle` },
    });
    await store.db.query('delete from turns where agent_id = $1', [working]);
  });
});
