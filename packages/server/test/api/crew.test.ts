import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS_CHANNEL, type Store } from '../../src/store/index.js';
import { TIMEOUT, intentRow, startTestApi, type TestApi } from './harness.js';

const project = 'crew';

describe('crew intents are recorded for the Driver', () => {
  let t: TestApi;
  let store: Store;

  const insertAgent = async (status: string) => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, 'otter', 'builder', $2) returning id`,
      [store.projectId, status],
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

  it('checks the round exists and is still open', async () => {
    const missing = await t.send('round.end', {
      project,
      roundId: crypto.randomUUID(),
    });
    expect(missing.status).toBe(404);
    const { rows } = await store.db.query<{ id: string }>(
      `insert into rounds (project_id, number, status)
       values ($1, 1, 'ended') returning id`,
      [store.projectId],
    );
    const ended = await t.send('round.end', { project, roundId: rows[0]?.id });
    expect(ended.status).toBe(409);
  });

  it.each(['agent.pause', 'agent.resume', 'agent.end', 'agent.kill'])(
    '%s queues for a live agent',
    async (name) => {
      const agentId = await insertAgent('working');
      const res = await t.send(name, { project, agentId });
      expect(res.status).toBe(202);
    },
  );

  it('refuses lifecycle intents for an agent that is gone', async () => {
    const agentId = await insertAgent('retired');
    const res = await t.send('agent.retire', { project, agentId });
    expect(res).toMatchObject({
      status: 409,
      body: { error: `agent ${agentId} is already retired` },
    });
    const unknown = await t.send('agent.message', {
      project,
      agentId: crypto.randomUUID(),
      text: 'hello',
    });
    expect(unknown.status).toBe(404);
  });

  it('writes nothing when a check fails', async () => {
    const { rows } = await store.db.query<{ count: number }>(
      `select count(*)::int as count from intents where kind = 'agent.retire'`,
    );
    expect(rows).toEqual([{ count: 0 }]);
  });
});
