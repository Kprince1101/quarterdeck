import { parseGridLayout, presetLayout } from '@quarterdeck/server/layouts';
import {
  streamMessageSchema,
  type StreamMessage,
} from '@quarterdeck/server/stream-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentError, openStream } from '../../src/api/index.js';
import type { IntentClient, RulesReader } from '../../src/api/index.js';
import { DEMO_ROUND_PLANS } from '../../src/demo/demo-plans.js';
import {
  BEATS_BETWEEN_ROUNDS,
  DEMO_STREAM_URL,
  createDemoServer,
  type DemoServer,
} from '../../src/demo/demo-server.js';
import { CARD_PATIENCE_BEATS } from '../../src/demo/demo-script.js';
import { DEMO_LAYOUT, DEMO_PROJECT } from '../../src/demo/demo-seed.js';
import {
  PLANNER_HEAR_MS,
  PLANNER_REPLY_MS,
} from '../../src/demo/demo-intents.js';

const project = DEMO_PROJECT;

const ROUND_BEATS = 20 + CARD_PATIENCE_BEATS;

const parts = (server: DemoServer) => {
  const { intents, rules } = server.sources as {
    intents: IntentClient;
    rules: RulesReader;
  };
  return { intents, rules, store: server.store, world: server.world };
};

const openRound = (server: DemoServer) => {
  const round = server.world.openRound();
  if (round === undefined) throw new Error('no open round');
  return round;
};

const openCard = (server: DemoServer) =>
  server.store.rows('cards').find((card) => card.status === 'open');

const stepUntil = (server: DemoServer, done: () => boolean, limit = 200) => {
  for (let steps = 0; steps < limit; steps += 1) {
    if (done()) return steps;
    server.step();
  }
  throw new Error(`not done after ${limit} beats`);
};

const kinds = (server: DemoServer): string[] =>
  server.store.events().map((event) => event.kind);

describe('demo server', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on a finished round, a live one, a proposal and a notebook', () => {
    const server = createDemoServer();
    const { store } = parts(server);
    const rounds = store.rows('rounds').map(({ number, status, goal }) => ({
      number,
      status,
      goal,
    }));
    expect(rounds).toEqual([
      { number: 1, status: 'ended', goal: DEMO_ROUND_PLANS[0]?.goal },
      { number: 2, status: 'active', goal: DEMO_ROUND_PLANS[1]?.goal },
    ]);
    const live = store
      .rows('agents')
      .filter((agent) => agent.roundId === openRound(server).id)
      .map((agent) => agent.role)
      .toSorted();
    expect(live).toEqual(['builder', 'builder', 'driver', 'reviewer']);
    expect(store.rows('tickets').map((ticket) => ticket.status)).toContain(
      'proposed',
    );
    expect(
      store.rows('notebook_proposals').filter((row) => row.status === 'open'),
    ).toHaveLength(1);
    expect(store.rows('notebook').length).toBeGreaterThan(0);
    expect(kinds(server)).toEqual(
      expect.arrayContaining(['planner.human', 'planner.reply', 'round.ended']),
    );
  });

  it('dates the history it opens on in the past and never in the future', () => {
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    const server = createDemoServer({ now: () => now });
    const times = server.store
      .events()
      .map((event) => Date.parse(event.createdAt));
    expect(Math.min(...times)).toBeLessThan(now - 20 * 60 * 1000);
    expect(Math.max(...times)).toBeLessThanOrEqual(now);
  });

  it('writes only messages the stream schema accepts', () => {
    const server = createDemoServer();
    const messages: StreamMessage[] = [];
    server.store.connect(0, (message) => messages.push(message));
    stepUntil(server, () => server.store.rows('rounds').length === 3);
    expect(messages.length).toBeGreaterThan(100);
    messages.forEach((message) => {
      expect(streamMessageSchema.safeParse(message).success).toBe(true);
    });
  });

  it('plays a round to its end and starts the next on its own', () => {
    const server = createDemoServer();
    const round = openRound(server);
    stepUntil(
      server,
      () => server.store.find('rounds', round.id)?.status === 'ended',
      ROUND_BEATS,
    );
    const tickets = server.store
      .rows('tickets')
      .filter((ticket) => ticket.roundId === round.id);
    expect(tickets.map((ticket) => ticket.status)).toEqual([
      'done',
      'done',
      'done',
    ]);
    expect(
      server.store
        .rows('agents')
        .filter((agent) => agent.roundId === round.id)
        .every((agent) => agent.status === 'retired'),
    ).toBe(true);
    expect(kinds(server)).toEqual(
      expect.arrayContaining([
        'ticket.bounced',
        'ticket.merged',
        'card.expired',
      ]),
    );

    const waited = stepUntil(
      server,
      () => server.world.openRound() !== undefined,
    );
    expect(waited).toBe(BEATS_BETWEEN_ROUNDS);
    expect(openRound(server).goal).toBe(DEMO_ROUND_PLANS[2]?.goal);
  });

  it('waits on a card until a person answers it', async () => {
    const server = createDemoServer();
    const { intents } = parts(server);
    stepUntil(server, () => openCard(server) !== undefined);
    const card = openCard(server);
    if (card === undefined) throw new Error('no card');

    await expect(
      intents.card.answer({ project, cardId: card.id, answer: 'Maybe' }),
    ).rejects.toMatchObject({ status: 400 });
    const [, other] = card.options as string[];
    const reply = await intents.card.answer({
      project,
      cardId: card.id,
      answer: other ?? '',
    });

    expect(reply).toMatchObject({ intent: 'card.answer', status: 'applied' });
    expect(server.store.find('cards', card.id)).toMatchObject({
      status: 'answered',
      answer: other,
    });
    const said = () =>
      [...server.world.turnText.values()].some((text) =>
        text.input.includes(`Go with "${other}"`),
      );
    const beats = stepUntil(server, said);
    expect(beats).toBeLessThan(CARD_PATIENCE_BEATS);
    expect(server.store.find('cards', card.id)?.status).toBe('answered');
  });

  it('holds the script while the project is paused', async () => {
    const server = createDemoServer();
    const { intents, store } = parts(server);
    await intents.pause.set({ project, paused: true });
    const before = store.events().length;
    server.step();
    server.step();
    expect(store.events()).toHaveLength(before);
    await intents.pause.set({ project, paused: false });
    server.step();
    expect(store.events().length).toBeGreaterThan(before + 1);
  });

  it('pauses everywhere through the machine state the Board reads', async () => {
    const server = createDemoServer();
    const { intents, store } = parts(server);
    const messages: StreamMessage[] = [];
    store.connect(null, (message) => messages.push(message));
    const reply = await intents.pause.all({ paused: true });
    expect(reply.result).toEqual({
      paused: true,
      projects: [project],
      failed: [],
    });
    expect(messages.at(-2)).toMatchObject({
      type: 'machine',
      machine: { pausedAt: expect.any(String) },
    });
    const before = store.events().length;
    server.step();
    expect(store.events()).toHaveLength(before);

    await intents.pause.all({ paused: false });
    expect(store.machine()).toEqual({ pausedAt: null });
    server.step();
    expect(store.events().length).toBeGreaterThan(before + 1);
  });

  it('pauses and resumes one agent, refusing what cannot change', async () => {
    const server = createDemoServer();
    const { intents, store } = parts(server);
    const builder = store
      .rows('agents')
      .find((agent) => agent.role === 'builder' && !server.world.isGone(agent));
    const agentId = builder?.id ?? '';
    await expect(
      intents.agent.resume({ project, agentId }),
    ).rejects.toMatchObject({ status: 409 });
    await intents.agent.pause({ project, agentId });
    expect(store.find('agents', agentId)?.status).toBe('paused');
    await intents.agent.resume({ project, agentId });
    expect(store.find('agents', agentId)?.status).toBe('idle');
  });

  it('opens on a layout the grid accepts', () => {
    expect(parseGridLayout(DEMO_LAYOUT)).toEqual(DEMO_LAYOUT);
  });

  it('ends a round on request and starts one with the asked goal', async () => {
    const server = createDemoServer();
    const { intents } = parts(server);
    const round = openRound(server);
    await expect(
      intents.round.start({ project, goal: 'Too soon' }),
    ).rejects.toMatchObject({ status: 409 });

    await intents.round.end({ project, roundId: round.id });
    expect(server.store.find('rounds', round.id)?.status).toBe('ended');
    expect(
      server.store
        .rows('tickets')
        .filter((ticket) => ticket.roundId === round.id)
        .some((ticket) => ticket.status === 'open'),
    ).toBe(true);
    await expect(
      intents.round.kill({ project, roundId: round.id }),
    ).rejects.toMatchObject({ status: 409 });

    await intents.round.start({ project, goal: 'Tidy the berth list' });
    const next = openRound(server);
    expect(next).toMatchObject({ number: 3, goal: 'Tidy the berth list' });
    server.step();
    server.step();
    expect(server.store.find('rounds', next.id)?.status).toBe('active');
  });

  it('hands an approved Planner ticket to the next round', async () => {
    vi.useFakeTimers();
    const server = createDemoServer();
    const { intents, store } = parts(server);
    const reply = await intents.planner.message({
      project,
      text: 'Text crews when their berth is ready',
    });
    expect(reply.status).toBe('pending');
    vi.advanceTimersByTime(PLANNER_HEAR_MS);
    const human = store
      .events()
      .findLast((event) => event.kind === 'planner.human');
    expect(human?.payload).toMatchObject({ intentId: reply.id });
    vi.advanceTimersByTime(PLANNER_REPLY_MS);
    const proposed = store
      .events()
      .findLast((event) => event.kind === 'ticket.proposed');
    const ticketId = proposed?.ticketId ?? '';
    expect(store.find('tickets', ticketId)).toMatchObject({
      title: 'Text crews when their berth is ready',
      status: 'proposed',
    });

    await intents.ticket.approve({ project, ticketId });
    await expect(
      intents.ticket.reject({ project, ticketId }),
    ).rejects.toBeInstanceOf(IntentError);
    await intents.round.end({ project, roundId: openRound(server).id });
    stepUntil(server, () => store.find('tickets', ticketId)?.status !== 'open');
    expect(store.find('tickets', ticketId)?.roundId).toBe(openRound(server).id);
  });

  it('clears the Planner conversation on request', async () => {
    vi.useFakeTimers();
    const server = createDemoServer();
    const { intents, store } = parts(server);
    const reply = await intents.planner.new({ project });
    vi.advanceTimersByTime(PLANNER_HEAR_MS);
    const cleared = store
      .events()
      .findLast((event) => event.kind === 'planner.cleared');
    expect(cleared).toMatchObject({
      payload: { reason: 'new', intentId: reply.id },
    });
  });

  it('records intents as events, like the server', async () => {
    const server = createDemoServer();
    const { intents, store } = parts(server);
    const reply = await intents.notebook.add({
      project,
      body: 'Keep it short',
    });
    expect(store.events().at(-1)).toMatchObject({
      kind: 'notebook.add',
      payload: { intentId: reply.id, status: 'applied' },
    });
    const before = store.events().length;
    await intents.usage.read({ project });
    expect(store.events()).toHaveLength(before);
  });

  it('accepts a notebook proposal into the notebook', async () => {
    const server = createDemoServer();
    const { intents, store } = parts(server);
    const proposal = store
      .rows('notebook_proposals')
      .find((row) => row.status === 'open');
    await intents.notebook.decide({
      project,
      proposalId: proposal?.id ?? '',
      decision: 'accepted',
      body: 'Edited lesson',
    });
    expect(store.rows('notebook').map((entry) => entry.body)).toContain(
      'Edited lesson',
    );
  });

  it('saves and resets the layout', async () => {
    const server = createDemoServer();
    const { intents, store } = parts(server);
    await intents.layout.reset({ project, name: 'dashboard', preset: 'ops' });
    const rows = store.rows('layouts');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spec).toEqual(presetLayout('ops'));
  });

  it('answers the reads the widgets make', async () => {
    const server = createDemoServer();
    const { intents, store } = parts(server);
    const usage = await intents.usage.read({ project });
    expect(usage.result).toMatchObject({
      windowHours: 5,
      capTokens: 2_000_000,
    });
    expect(usage.result?.['percent']).toBeGreaterThan(0);

    const summary = await intents.data.summary({ project });
    expect(summary.result?.['tables']).toEqual(
      expect.arrayContaining([
        { table: 'events', rows: store.events().length },
      ]),
    );
    const page = await intents.data.rows({
      project,
      table: 'tickets',
      limit: 2,
    });
    expect(page.result).toMatchObject({
      table: 'tickets',
      total: store.rows('tickets').length,
    });
    expect(page.result?.['rows']).toHaveLength(2);
    await expect(
      intents.data.rows({ project, table: 'secrets' }),
    ).rejects.toMatchObject({ status: 404 });

    const driver = store
      .rows('agents')
      .find(
        (agent) =>
          agent.role === 'driver' && agent.roundId === openRound(server).id,
      );
    const turn = store.rows('turns').find((row) => row.agentId === driver?.id);
    const read = await intents.turn.read({ project, turnId: turn?.id ?? 0 });
    expect(read.result).toMatchObject({ round: 2, n: 1, latestSession: true });
    expect(read.result?.['input']).toContain('Round 2');
  });

  it('serves the shipped rules and keeps machine edits in the page', async () => {
    const server = createDemoServer();
    const { intents, rules } = parts(server);
    const view = await rules(project);
    const naming = view.rules.find((rule) => rule.name === 'naming');
    expect(naming?.defaults.content).toContain('"theme"');
    expect(naming?.machine.content).toBeNull();
    expect(view.repoPath).not.toBeNull();

    await intents.rules.write({
      scope: 'machine',
      name: 'naming',
      content: '{ "theme": "boats" }\n',
    });
    const written = await rules(null);
    expect(
      written.rules.find((rule) => rule.name === 'naming')?.machine.content,
    ).toBe('{ "theme": "boats" }\n');
    expect(written.repoPath).toBeNull();

    await intents.rules.reset({ scope: 'machine', name: 'lifecycle' });
    const reset = await intents.usage.read({ project });
    expect(reset.result).toMatchObject({ capTokens: null, percent: null });
  });

  it('refuses what a demo cannot do, with a reason', async () => {
    const server = createDemoServer();
    const { intents } = parts(server);
    await expect(
      intents.wipe.all({ confirm: 'wipe everything' }),
    ).rejects.toMatchObject({
      status: 501,
      message: expect.stringContaining('demo'),
    });
  });
});

describe('demo stream', () => {
  it('goes live over the in-page socket and resumes after its cursor', async () => {
    const server = createDemoServer();
    const connection = openStream({
      url: DEMO_STREAM_URL,
      WebSocket: server.sources.stream?.WebSocket,
    });
    await vi.waitFor(() => {
      expect(connection.state.status).toBe('live');
    });
    expect(connection.state.tables.projects[0]?.slug).toBe(project);
    expect(connection.state.events.at(-1)?.id).toBe(
      server.store.events().length,
    );

    server.step();
    expect(connection.state.events.at(-1)?.id).toBe(
      server.store.events().length,
    );
    connection.close();
  });
});
