import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PLANNER_BRIEF, PROJECT_ARCHIVED } from '../../src/planner/index.js';
import {
  SIGNED_IN,
  SIGN_IN_CARD,
  SIGN_IN_EVENTS,
} from '../../src/signin/index.js';
import { SIGNED_IN_AGAIN_TEXT, WAITING_TEXT } from '../acp/fake-agent/index.ts';
import { startTestApi, type TestApi } from '../api/harness.ts';
import { callTool, connectClient } from '../bus/fixtures.ts';
import {
  TIMEOUT,
  openPlannerProject,
  writeMachineRule,
  type PlannerProject,
} from './fixtures.ts';

const CHARTER_HEADING = '# Driver charter';
const settle = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });

describe('Planner', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  const opened: PlannerProject[] = [];

  const open = async (
    options: Parameters<typeof openPlannerProject>[1] = {},
  ): Promise<PlannerProject> => {
    const p = await openPlannerProject(t, options);
    opened.push(p);
    return p;
  };

  const say = async (p: PlannerProject, text: string) => {
    const res = await p.send('planner.message', { text });
    await p.planner().drain();
    return res.body.id;
  };

  const replies = async (p: PlannerProject) =>
    (await p.events())
      .filter((event) => event.kind === 'planner.reply')
      .map((event) => event.payload);

  const pauseEvents = async (p: PlannerProject) => {
    const { rows } = await p.store.db.query<{
      kind: string;
      agentId: string | null;
      payload: Record<string, unknown>;
    }>(
      `select kind, agent_id as "agentId", payload from events
       where project_id = $1 and kind like 'pause.%' and not (payload ? 'status')
       order by id`,
      [p.store.projectId],
    );
    return rows;
  };

  beforeAll(async () => {
    t = await startTestApi();
  }, TIMEOUT);

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((p) => p.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  it('births a Planner on the first message and opens with the brief and the charter', async () => {
    const p = await open();
    await p.start();
    const intentId = await say(p, 'build a login page');

    const [agent] = await p.agents();
    expect(agent).toMatchObject({ runtime: 'kiro', status: 'idle' });
    expect(agent?.sessionId).not.toBeNull();
    expect(await p.intent(intentId)).toEqual({
      status: 'applied',
      result: { agentId: agent?.id, seq: 1 },
    });
    expect(p.fake.launches).toEqual([
      {
        cwd: p.repoDir,
        env: { pass: [] },
        project: p.project,
        agentName: agent?.name,
        mcpServers: [expect.objectContaining({ name: 'bus' })],
      },
    ]);

    const events = await p.events();
    expect(events.map((event) => event.kind)).toEqual([
      'planner.human',
      'planner.reply',
    ]);
    expect(events[0]).toEqual({
      kind: 'planner.human',
      agentId: agent?.id,
      payload: { intentId, seq: 1, text: 'build a login page' },
    });
    const reply = events[1]?.payload as { text: string; stopReason: string };
    expect(reply.stopReason).toBe('end_turn');
    expect(reply.text.startsWith(PLANNER_BRIEF)).toBe(true);
    expect(reply.text).toContain(CHARTER_HEADING);
    expect(reply.text.endsWith('# The human\n\nbuild a login page')).toBe(true);

    const { rows } = await p.store.db.query(
      `select seq, stop_reason, prompt = $2 as echoed, ended_at is not null as ended
       from turns where agent_id = $1`,
      [agent?.id, reply.text],
    );
    expect(rows).toEqual([
      { seq: 1, stop_reason: 'end_turn', echoed: true, ended: true },
    ]);
  });

  it('keeps one session for the conversation and tells the Planner what the human decided', async () => {
    const p = await open();
    await p.start();
    await say(p, 'plan the store');
    const [agent] = await p.agents();
    const bus = await connectClient(p.store, agent?.id ?? '');
    const propose = async (title: string) =>
      (await callTool(bus, 'propose', { title })).text.replace('proposed ', '');
    const kept = await propose('QD2a store');
    const dropped = await propose('QD2z rewrite');
    await bus.close();
    expect((await p.send('ticket.approve', { ticketId: kept })).status).toBe(
      200,
    );
    expect((await p.send('ticket.reject', { ticketId: dropped })).status).toBe(
      200,
    );

    await say(p, 'what next?');
    await say(p, 'and then?');

    const [, second, third] = await replies(p);
    expect(second?.['text']).toBe(
      [
        '[Quarterdeck] Since your last reply the human decided on your proposals:',
        `- approved: QD2a store (${kept})`,
        `- rejected: QD2z rewrite (${dropped})`,
        '',
        'what next?',
      ].join('\n'),
    );
    expect(third?.['text']).toBe('and then?');
    expect(p.fake.launches).toHaveLength(1);
    expect(await p.agents()).toHaveLength(1);
  });

  it('starts a new conversation after planner.new, ending the old session and its process', async () => {
    const p = await open();
    await p.start();
    await say(p, 'hello');
    const [first] = await p.agents();

    const cleared = await p.send('planner.new');
    await p.planner().drain();
    expect(await p.intent(cleared.body.id)).toMatchObject({
      status: 'applied',
    });
    expect((await p.agents())[0]).toMatchObject({
      id: first?.id,
      status: 'retired',
      sessionId: null,
    });
    await p.fake.clients[0]?.closed;

    await say(p, 'again');
    const agents = await p.agents();
    expect(agents.map((agent) => agent.status)).toEqual(['retired', 'idle']);
    expect(p.fake.launches).toHaveLength(2);
    const [, second] = await replies(p);
    expect(String(second?.['text']).startsWith(PLANNER_BRIEF)).toBe(true);
    expect((await p.events()).map((event) => event.kind)).toEqual([
      'planner.human',
      'planner.reply',
      'planner.cleared',
      'planner.human',
      'planner.reply',
    ]);
    const clearedEvent = (await p.events())[2];
    expect(clearedEvent).toEqual({
      kind: 'planner.cleared',
      agentId: first?.id,
      payload: { reason: 'new', intentId: cleared.body.id },
    });
  });

  it('cancels a turn in flight when the human starts a new conversation', async () => {
    const p = await open();
    await p.start();
    await say(p, 'hello');
    const client = p.fake.clients[0];
    const waiting = new Promise<void>((resolve) => {
      client?.subscribe((event) => {
        if (
          event.type === 'session_update' &&
          event.update.sessionUpdate === 'agent_message_chunk' &&
          event.update.content.type === 'text' &&
          event.update.content.text === WAITING_TEXT
        )
          resolve();
      });
    });

    await p.send('planner.message', { text: 'wait_for_cancel' });
    const draining = p.planner().drain();
    await waiting;
    await p.send('planner.new');
    await draining;
    await p.planner().drain();

    const [, second] = await replies(p);
    expect(second).toMatchObject({
      seq: 2,
      stopReason: 'cancelled',
      text: WAITING_TEXT,
    });
    expect((await p.agents()).map((agent) => agent.status)).toEqual([
      'retired',
    ]);
  });

  it('drops messages queued before a new conversation and answers the rest in it', async () => {
    const p = await open();
    const one = await p.send('planner.message', { text: 'one' });
    const two = await p.send('planner.message', { text: 'two' });
    const cleared = await p.send('planner.new');
    const three = await p.send('planner.message', { text: 'three' });
    await p.start();
    await p.planner().drain();

    const superseded = {
      status: 'rejected',
      result: { error: 'superseded by a new conversation' },
    };
    expect(await p.intent(one.body.id)).toEqual(superseded);
    expect(await p.intent(two.body.id)).toEqual(superseded);
    expect(await p.intent(cleared.body.id)).toMatchObject({
      status: 'applied',
    });
    expect(await p.intent(three.body.id)).toMatchObject({ status: 'applied' });
    expect(p.fake.launches).toHaveLength(1);
    const [only] = await replies(p);
    expect(String(only?.['text']).endsWith('three')).toBe(true);
  });

  it('refuses a message while the project has no repository path', async () => {
    const p = await open({ repo: false });
    await p.start();
    const intentId = await say(p, 'hello');

    const error =
      "Set the project's repository path before talking to the Planner.";
    expect(await p.intent(intentId)).toEqual({
      status: 'rejected',
      result: { error },
    });
    expect(await p.events()).toEqual([
      { kind: 'planner.failed', agentId: null, payload: { intentId, error } },
    ]);
    expect(await p.agents()).toEqual([]);
    expect(p.fake.launches).toEqual([]);
  });

  const signInCard = async (p: PlannerProject) => {
    const open = async () => {
      const { rows } = await p.store.db.query<{
        id: string;
        agentId: string;
        recommendation: string;
      }>(
        `select id, agent_id as "agentId", recommendation from cards
         where project_id = $1 and kind = $2 and status = 'open'`,
        [p.store.projectId, SIGN_IN_CARD],
      );
      return rows;
    };
    await settle(async () => expect(await open()).toHaveLength(1));
    const [card] = await open();
    if (!card) throw new Error('no open sign-in card');
    return card;
  };

  const authEvents = async (p: PlannerProject) => {
    const { rows } = await p.store.db.query<{
      kind: string;
      payload: Record<string, unknown>;
    }>(
      `select kind, payload from events
       where project_id = $1 and kind = any($2::text[]) order by id`,
      [p.store.projectId, Object.values(SIGN_IN_EVENTS)],
    );
    return rows;
  };

  it('waits on a sign-in card when the runtime is not signed in, then opens the session', async () => {
    const p = await open({ fake: { requireAuth: true } });
    await p.start();
    const sent = await p.send('planner.message', { text: 'hello' });
    const draining = p.planner().drain();

    const card = await signInCard(p);
    const [agent] = await p.agents();
    expect(card).toMatchObject({
      agentId: agent?.id,
      recommendation: 'kiro-cli login',
    });
    p.fake.options.requireAuth = false;
    expect(
      (await p.send('card.answer', { cardId: card.id, answer: SIGNED_IN }))
        .status,
    ).toBe(200);
    await draining;

    expect(await p.intent(sent.body.id)).toMatchObject({ status: 'applied' });
    expect((await p.agents()).map((row) => row.status)).toEqual(['idle']);
    expect(p.fake.launches).toHaveLength(2);
    await p.fake.clients[0]?.closed;
    expect((await authEvents(p)).map((event) => event.kind)).toEqual([
      SIGN_IN_EVENTS.required,
      SIGN_IN_EVENTS.resumed,
    ]);
    expect((await replies(p)).map((reply) => reply['stopReason'])).toEqual([
      'end_turn',
    ]);
  });

  it('refuses the message with the command when sign-in is declined, and frees the name', async () => {
    const p = await open({ fake: { requireAuth: true } });
    await p.start();
    const sent = await p.send('planner.message', { text: 'hello' });
    const draining = p.planner().drain();

    const card = await signInCard(p);
    await p.send('card.decline', { cardId: card.id });
    await draining;

    const outcome = await p.intent(sent.body.id);
    expect(outcome.status).toBe('rejected');
    expect(JSON.stringify(outcome.result)).toContain('`kiro-cli login`');
    expect((await p.agents()).map((agent) => agent.status)).toEqual([
      'retired',
    ]);
    const { rows } = await p.store.db.query(
      `select count(*)::int as n from events
       where project_id = $1 and kind = 'agent.birth_failed'`,
      [p.store.projectId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('resends a message whose sign-in lapsed mid-conversation once the card is answered', async () => {
    const p = await open();
    await p.start();
    await say(p, 'hello');
    const sent = await p.send('planner.message', { text: 'sign_in_lapsed' });
    const draining = p.planner().drain();

    const card = await signInCard(p);
    expect((await authEvents(p))[0]?.payload).toMatchObject({
      cardId: card.id,
      operation: 'session/prompt',
    });
    await p.send('card.answer', { cardId: card.id, answer: SIGNED_IN });
    await draining;

    expect(await p.intent(sent.body.id)).toMatchObject({ status: 'applied' });
    const [, second] = await replies(p);
    expect(second).toMatchObject({ seq: 2, text: SIGNED_IN_AGAIN_TEXT });
    expect(p.fake.launches).toHaveLength(1);
  });

  it('stops waiting on sign-in when the human starts a new conversation', async () => {
    const p = await open({ fake: { requireAuth: true } });
    await p.start();
    const sent = await p.send('planner.message', { text: 'hello' });
    const draining = p.planner().drain();
    const card = await signInCard(p);

    await p.send('planner.new');
    await draining;
    await p.planner().drain();

    const outcome = await p.intent(sent.body.id);
    expect(outcome.status).toBe('rejected');
    expect(JSON.stringify(outcome.result)).toContain('the card stays open');
    expect((await signInCard(p)).id).toBe(card.id);
  });

  it('ends the conversation when the agent process dies mid-turn, and the next message starts afresh', async () => {
    const p = await open();
    await p.start();
    await say(p, 'hello');
    const crashed = await say(p, 'crash');

    expect(await p.intent(crashed)).toMatchObject({ status: 'applied' });
    const events = await p.events();
    expect(events.slice(2).map((event) => event.kind)).toEqual([
      'planner.human',
      'planner.failed',
      'planner.cleared',
    ]);
    expect(events[3]?.payload).toMatchObject({ seq: 2, intentId: crashed });
    expect(events[4]?.payload).toEqual({ reason: 'failed', intentId: null });
    const { rows } = await p.store.db.query(
      `select t.stop_reason, t.ended_at is not null as ended from turns t
       join agents a on a.id = t.agent_id
       where a.project_id = $1 and t.seq = 2`,
      [p.store.projectId],
    );
    expect(rows).toEqual([{ stop_reason: null, ended: true }]);

    await say(p, 'are you back?');
    expect((await p.agents()).map((agent) => agent.status)).toEqual([
      'retired',
      'idle',
    ]);
  });

  it('refuses a message while the budget holds launches, without birthing a Planner', async () => {
    await writeMachineRule(t.homeDir, 'lifecycle.json', {
      budget: { window: { capTokens: 1000 } },
    });
    try {
      const p = await open();
      const { rows } = await p.store.db.query<{ id: string }>(
        `insert into agents (project_id, name, role, status)
         values ($1, 'spender', 'builder', 'ended') returning id`,
        [p.store.projectId],
      );
      await p.store.db.query(
        `insert into turns (agent_id, seq, prompt, input_tokens, ended_at)
         values ($1, 1, 'go', 800, now())`,
        [rows[0]?.id],
      );
      await p.start();
      const intentId = await say(p, 'hello');

      expect(await p.intent(intentId)).toMatchObject({
        status: 'rejected',
        result: { error: expect.stringContaining('Launches are held') },
      });
      expect(await p.agents()).toEqual([]);
      expect(p.fake.launches).toEqual([]);
      expect((await p.events()).map((event) => event.kind)).toEqual([
        'planner.failed',
      ]);
      const held = await p.store.db.query(
        `select count(*)::int as n from events
         where project_id = $1 and kind = 'budget.held'`,
        [p.store.projectId],
      );
      expect(held.rows).toEqual([{ n: 1 }]);
    } finally {
      await rm(join(t.homeDir, '.quarterdeck', 'rules.local.lifecycle.json'));
    }
  });

  it('runs on the runtime the models rule names for the Planner', async () => {
    await writeMachineRule(t.homeDir, 'models.json', {
      planner: { runtime: 'claude' },
    });
    try {
      const p = await open();
      await p.start();
      await say(p, 'hello');
      expect((await p.agents())[0]?.runtime).toBe('claude');
    } finally {
      await rm(join(t.homeDir, '.quarterdeck', 'rules.local.models.json'));
    }
  });

  it('passes the names the project env rule adds to the Planner', async () => {
    const p = await open();
    await mkdir(join(p.repoDir, '.quarterdeck'), { recursive: true });
    await writeFile(
      join(p.repoDir, '.quarterdeck', 'rules.local.env.json'),
      JSON.stringify({ pass: ['EXAMPLE_TOKEN'] }),
    );
    await p.start();
    await say(p, 'hello');
    expect(p.fake.launches[0]?.env).toEqual({ pass: ['EXAMPLE_TOKEN'] });
  });

  it('retires a Planner left over from an earlier run when it starts', async () => {
    const p = await open();
    const { rows } = await p.store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status, session_id)
       values ($1, 'heron', 'planner', 'idle', 'gone') returning id`,
      [p.store.projectId],
    );
    await p.start();

    expect(await p.agents()).toEqual([
      expect.objectContaining({ id: rows[0]?.id, status: 'retired' }),
    ]);
    expect(await p.events()).toEqual([
      {
        kind: 'planner.cleared',
        agentId: rows[0]?.id,
        payload: { reason: 'restart', intentId: null },
      },
    ]);
  });

  it('retires the conversation on close and handles nothing after', async () => {
    const p = await open();
    await p.start();
    await say(p, 'hello');
    await p.planner().close();

    expect((await p.agents()).map((agent) => agent.status)).toEqual([
      'retired',
    ]);
    await p.fake.clients[0]?.closed;
    const late = await p.send('planner.message', { text: 'still there?' });
    await p.planner().drain();
    await settle(async () => {
      expect((await p.events()).at(-1)?.payload).toEqual({
        reason: 'shutdown',
        intentId: null,
      });
    });
    expect(await p.intent(late.body.id)).toMatchObject({ status: 'pending' });
    expect(p.errors).toEqual([]);
  });

  it('holds a message while the project is paused and answers it on unpause', async () => {
    const p = await open();
    await p.start();
    expect((await p.send('pause.set', { paused: true })).status).toBe(200);
    const sent = await p.send('planner.message', { text: 'plan the login' });
    await settle(async () => {
      expect(await pauseEvents(p)).toHaveLength(1);
    });

    expect(await pauseEvents(p)).toEqual([
      {
        kind: 'pause.held',
        agentId: null,
        payload: {
          operation: 'planner.turn',
          label: 'message: plan the login',
          scopes: ['project'],
        },
      },
    ]);
    expect(await p.agents()).toEqual([]);
    expect(await p.intent(sent.body.id)).toMatchObject({ status: 'pending' });

    await p.send('pause.set', { paused: false });
    await settle(async () => {
      expect(await p.intent(sent.body.id)).toMatchObject({ status: 'applied' });
    });
    await p.planner().drain();

    expect(await replies(p)).toHaveLength(1);
    expect((await pauseEvents(p)).map((event) => event.kind)).toEqual([
      'pause.held',
      'pause.replayed',
    ]);
  });

  it('holds a message for a paused Planner and sends it on resume', async () => {
    const p = await open();
    await p.start();
    await say(p, 'hello');
    const [agent] = await p.agents();
    const agentId = agent?.id ?? '';
    expect((await p.send('agent.pause', { agentId })).status).toBe(200);

    const sent = await p.send('planner.message', { text: 'still there?' });
    await settle(async () => {
      expect(await pauseEvents(p)).toHaveLength(1);
    });
    expect((await pauseEvents(p))[0]).toMatchObject({
      agentId,
      payload: { scopes: ['agent'] },
    });

    expect((await p.send('agent.resume', { agentId })).status).toBe(200);
    await settle(async () => {
      expect(await p.intent(sent.body.id)).toMatchObject({ status: 'applied' });
    });
    await p.planner().drain();
    expect(await replies(p)).toHaveLength(2);
    expect((await p.agents())[0]?.status).toBe('idle');
  });

  it('drops a held message when a new conversation starts', async () => {
    const p = await open();
    await p.start();
    await p.send('pause.set', { paused: true });
    const held = await p.send('planner.message', { text: 'one' });
    await settle(async () => {
      expect(await pauseEvents(p)).toHaveLength(1);
    });

    const cleared = await p.send('planner.new');
    await settle(async () => {
      expect(await p.intent(cleared.body.id)).toMatchObject({
        status: 'applied',
      });
    });

    expect(await p.intent(held.body.id)).toEqual({
      status: 'rejected',
      result: { error: 'superseded by a new conversation' },
    });
    expect((await pauseEvents(p)).map((event) => event.kind)).toEqual([
      'pause.held',
      'pause.dropped',
    ]);
    expect(await p.agents()).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  it('ends the conversation when the project is archived, refuses messages until unarchived, then starts afresh', async () => {
    const p = await open();
    await p.start();
    await say(p, 'hello');
    const [first] = await p.agents();

    expect((await p.send('project.archive', { archived: true })).status).toBe(
      200,
    );
    await settle(async () => {
      expect((await p.agents())[0]?.status).toBe('retired');
    });
    await p.fake.clients[0]?.closed;
    const refused = await say(p, 'still there?');

    expect(await p.intent(refused)).toEqual({
      status: 'rejected',
      result: { error: PROJECT_ARCHIVED },
    });
    expect(p.fake.launches).toHaveLength(1);
    const cleared = (await p.events()).find(
      (event) => event.kind === 'planner.cleared',
    );
    expect(cleared).toEqual({
      kind: 'planner.cleared',
      agentId: first?.id,
      payload: { reason: 'archived', intentId: null },
    });

    await p.send('project.archive', { archived: false });
    const back = await say(p, 'back again');

    expect(await p.intent(back)).toMatchObject({ status: 'applied' });
    expect((await p.agents()).map((agent) => agent.status)).toEqual([
      'retired',
      'idle',
    ]);
    expect(p.fake.launches).toHaveLength(2);
    expect(p.errors).toEqual([]);
  });

  it('starts afresh when its Planner was retired from outside', async () => {
    const p = await open();
    await p.start();
    await say(p, 'hello');
    const [first] = await p.agents();
    await p.store.db.query(
      `update agents set status = 'retired', session_id = null where id = $1`,
      [first?.id],
    );

    const next = await say(p, 'are you there?');

    expect(await p.intent(next)).toMatchObject({ status: 'applied' });
    await p.fake.clients[0]?.closed;
    expect((await p.agents()).map((agent) => agent.status)).toEqual([
      'retired',
      'idle',
    ]);
    expect(
      (await p.events()).find((event) => event.kind === 'planner.cleared'),
    ).toMatchObject({ payload: { reason: 'retired', intentId: null } });
  });

  it('drops a held message on close and leaves it pending', async () => {
    const p = await open();
    await p.start();
    await p.send('pause.set', { paused: true });
    const held = await p.send('planner.message', { text: 'one' });
    await settle(async () => {
      expect(await pauseEvents(p)).toHaveLength(1);
    });

    await p.planner().close();

    expect(await p.intent(held.body.id)).toMatchObject({ status: 'pending' });
    expect(p.errors).toEqual([]);
  });
});
