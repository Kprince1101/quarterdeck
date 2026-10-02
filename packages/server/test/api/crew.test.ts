import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS_CHANNEL, type Store } from '../../src/store/index.js';
import { TIMEOUT, intentRow, startTestApi, type TestApi } from './harness.js';

const project = 'crew';

describe(
  'crew intents are recorded for the Driver',
  { timeout: TIMEOUT },
  () => {
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
      ['round.start', { goal: 'ship QD6' }],
      ['pause.set', { paused: true }],
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
      ['round.end', 1],
      ['round.kill', 2],
    ])('%s checks the round exists and is still open', async (name, number) => {
      const missing = await t.send(name, {
        project,
        roundId: crypto.randomUUID(),
      });
      expect(missing.status).toBe(404);
      const { rows } = await store.db.query<{ id: string; status: string }>(
        `insert into rounds (project_id, number, status)
       values ($1, $2, 'ended'), ($1, $3, 'active') returning id, status`,
        [store.projectId, number * 10, number * 10 + 1],
      );
      const [ended, open] = rows;
      const refused = await t.send(name, { project, roundId: ended?.id });
      expect(refused.status).toBe(409);
      const queued = await t.send(name, { project, roundId: open?.id });
      expect(queued).toMatchObject({
        status: 202,
        body: { intent: name, status: 'pending' },
      });
    });

    it.each(['agent.pause', 'agent.resume', 'agent.end', 'agent.kill'])(
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

    it.each([
      ['agent.pause', {}],
      ['agent.kill', {}],
      ['agent.message', { text: 'hi' }],
    ])('%s refuses an agent that has ended', async (name, extra) => {
      const agentId = await insertAgent('ended');
      const res = await t.send(name, { project, agentId, ...extra });
      expect(res.status).toBe(409);
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
  },
);
