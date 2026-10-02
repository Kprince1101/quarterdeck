import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import type { BudgetWindow } from '@quarterdeck/rules';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  NotADriverError,
  ROUND_STARTED_EVENT,
  RoundEndedError,
  RoundNotFoundError,
  STUCK_AFTER_CONTINUES,
  STUCK_SURFACED_EVENT,
  TURN_EVENTS,
  flagIfStuck,
  markStuckFlagsSurfaced,
  openDriverRound,
  unsurfacedStuckFlags,
  turnDir,
  turnFile,
  type DriverRound,
  type DriverRoundOptions,
} from '../../src/driver/index.js';
import { BudgetHeldError } from '../../src/budget/index.js';
import { startPauseGate, type PauseGate } from '../../src/pause/index.js';
import {
  SIGNED_IN,
  SIGN_IN_CARD,
  SIGN_IN_EVENTS,
  SignInRequiredError,
} from '../../src/signin/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  CLAUDE_LOGIN,
  CLAUDE_TERMINAL_COMMAND,
} from '../signin/auth-methods.js';
import {
  resultText,
  say,
  signInNeeded,
  startScriptedAgent,
  type ScriptedAgent,
} from './scripted-agent.js';

const TIMEOUT = 30_000;
const settle = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });
const CHARTER = '# Driver charter\n\nTurn tickets into merged pull requests.';
const RESULT = { summary: 'Nothing to assign yet.', actions: [] };
const NO_CAP: BudgetWindow = { hours: 5, capTokens: null, holdAtFraction: 0.8 };
const BUS: McpServerStdio = {
  name: 'quarterdeck',
  command: 'node',
  args: ['relay.js'],
  env: [],
};

interface TurnRow {
  seq: number;
  prompt: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  transcriptPath: string | null;
  ended: boolean;
}

describe('Driver turn loop', () => {
  let store: Store;
  let scripted: ScriptedAgent;
  let turnsDir: string;
  let launched: string[];
  let pauseGate: PauseGate;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    scripted = await startScriptedAgent();
    turnsDir = await mkdtemp(join(tmpdir(), 'qd-turns-'));
    launched = [];
    pauseGate = await startPauseGate({ store, home: join(turnsDir, 'home') });
  });

  afterEach(async () => {
    await pauseGate.close();
    await scripted.client.close();
    await rm(turnsDir, { recursive: true, force: true });
    await store.db.exec(
      `delete from events; delete from turns; delete from notebook;
       delete from cards; delete from tickets; delete from agents;
       delete from rounds; update projects set paused_at = null;`,
    );
  });

  const insertRound = async (
    number: number,
    status = 'active',
    goal = 'Ship the turn loop.',
  ): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into rounds (project_id, number, status, goal)
       values ($1, $2, $3, $4) returning id`,
      [store.projectId, number, status, goal],
    );
    return rows[0]?.id ?? '';
  };

  const insertAgent = async (
    role = 'driver',
    status = 'idle',
  ): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, $2, $3, $4) returning id`,
      [store.projectId, `${role}-${status}`, role, status],
    );
    return rows[0]?.id ?? '';
  };

  const addNote = async (body: string, pinned: boolean, at: string) => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into notebook (project_id, body, pinned, created_at)
       values ($1, $2, $3, $4) returning id`,
      [store.projectId, body, pinned, at],
    );
    return rows[0]?.id ?? '';
  };

  const options = (agentId: string, roundId: string): DriverRoundOptions => ({
    store,
    client: scripted.client,
    bus: {
      launch: async (id) => {
        launched.push(id);
        return BUS;
      },
    },
    agentId,
    roundId,
    cwd: '/work/deck',
    charter: CHARTER,
    turnsDir,
    budget: NO_CAP,
    pause: pauseGate,
  });

  const open = async (): Promise<DriverRound> => {
    const agentId = await insertAgent();
    const roundId = await insertRound(1);
    return openDriverRound(options(agentId, roundId));
  };

  const turnRows = async (agentId: string): Promise<TurnRow[]> => {
    const { rows } = await store.db.query<TurnRow>(
      `select seq, prompt, stop_reason as "stopReason",
              input_tokens as "inputTokens", output_tokens as "outputTokens",
              transcript_path as "transcriptPath", ended_at is not null as ended
       from turns where agent_id = $1 order by seq`,
      [agentId],
    );
    return rows;
  };

  const events = async (kind: string) => {
    const { rows } = await store.db.query<{ payload: Record<string, unknown> }>(
      'select payload from events where kind = $1 order by id',
      [kind],
    );
    return rows.map((row) => row.payload);
  };

  const agentRow = async (agentId: string) => {
    const { rows } = await store.db.query<{
      status: string;
      sessionId: string | null;
      roundId: string | null;
    }>(
      `select status, session_id as "sessionId", round_id as "roundId"
       from agents where id = $1`,
      [agentId],
    );
    return rows[0];
  };

  it(
    'opens one session with the bus and births the Driver with the active notebook',
    async () => {
      const older = await addNote(
        'Reviews go to reviewer-1.',
        false,
        '2026-01-01',
      );
      const newer = await addNote('Never touch main.', false, '2026-02-01');
      const pinned = await addNote('PRs need tests.', true, '2026-03-01');
      scripted.reply(say(resultText(RESULT)));

      const round = await open();
      const birth = await round.birth;

      expect(birth).toEqual({
        status: 'result',
        result: RESULT,
        turns: [expect.objectContaining({ seq: 1, stopReason: 'end_turn' })],
      });
      expect(scripted.sessions).toEqual([
        { sessionId: round.sessionId, cwd: '/work/deck', mcpServers: [BUS] },
      ]);
      expect(launched).toEqual([round.agent.id]);
      expect(round.notebook.map((entry) => entry.id)).toEqual([
        pinned,
        older,
        newer,
      ]);

      const [prompt] = scripted.prompts;
      expect(prompt?.sessionId).toBe(round.sessionId);
      const input = prompt?.text ?? '';
      expect(input).toContain(CHARTER);
      expect(input).toContain('round 1');
      expect(input).toContain('Ship the turn loop.');
      expect(input).toContain('### Entry 1 (pinned)\n\nPRs need tests.');
      expect(input.indexOf('PRs need tests.')).toBeLessThan(
        input.indexOf('Reviews go to reviewer-1.'),
      );
      expect(input.indexOf('Reviews go to reviewer-1.')).toBeLessThan(
        input.indexOf('Never touch main.'),
      );
      expect(input).toContain('```json');

      expect(await events(ROUND_STARTED_EVENT)).toEqual([
        {
          roundId: round.round.id,
          round: 1,
          sessionId: round.sessionId,
          notebook: [pinned, older, newer],
        },
      ]);
      expect(await agentRow(round.agent.id)).toEqual({
        status: 'idle',
        sessionId: round.sessionId,
        roundId: round.round.id,
      });
    },
    TIMEOUT,
  );

  it('says when the notebook is empty', async () => {
    scripted.reply(say(resultText(RESULT)));

    const round = await open();
    await round.birth;

    expect(scripted.prompts[0]?.text).toContain('The notebook is empty.');
  });

  it('saves each turn input and output as files and as a turns row', async () => {
    scripted.reply(
      say(resultText(RESULT), {
        usage: { inputTokens: 1200, outputTokens: 80 },
      }),
    );

    const round = await open();
    await round.birth;

    const dir = turnDir(turnsDir, round.agent.id, 1);
    expect(dir).toBe(join(turnsDir, round.agent.id, '0001'));
    const input = await readFile(turnFile(dir, 'input'), 'utf8');
    expect(input).toBe(scripted.prompts[0]?.text);
    expect(await readFile(turnFile(dir, 'output'), 'utf8')).toBe(
      resultText(RESULT),
    );
    expect(JSON.parse(await readFile(turnFile(dir, 'result'), 'utf8'))).toEqual(
      RESULT,
    );
    const updates = (await readFile(turnFile(dir, 'updates'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sessionUpdate: string });
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      'agent_message_chunk',
    ]);

    expect(await turnRows(round.agent.id)).toEqual([
      {
        seq: 1,
        prompt: input,
        stopReason: 'end_turn',
        inputTokens: 1200,
        outputTokens: 80,
        transcriptPath: dir,
        ended: true,
      },
    ]);
    expect(await events(TURN_EVENTS.result)).toEqual([
      { seq: 1, result: RESULT },
    ]);
  });

  it(
    'keeps every turn of the round in the one session',
    async () => {
      scripted.reply(
        say(resultText(RESULT)),
        say(resultText({ summary: 'Assigned QD1.', actions: [] })),
        say(resultText({ summary: 'Waiting on review.', actions: [] })),
      );

      const round = await open();
      await round.birth;
      const second = await round.turn('heron reported QD1.');
      const third = await round.turn('reviewer-1 approved QD1.');

      expect(second.status === 'result' && second.result.summary).toBe(
        'Assigned QD1.',
      );
      expect(third.status === 'result' && third.result.summary).toBe(
        'Waiting on review.',
      );
      expect(scripted.sessions).toHaveLength(1);
      expect(scripted.prompts.map((prompt) => prompt.sessionId)).toEqual([
        round.sessionId,
        round.sessionId,
        round.sessionId,
      ]);
      expect(scripted.prompts.slice(1).map((prompt) => prompt.text)).toEqual([
        'heron reported QD1.',
        'reviewer-1 approved QD1.',
      ]);
      expect((await turnRows(round.agent.id)).map((row) => row.seq)).toEqual([
        1, 2, 3,
      ]);
    },
    TIMEOUT,
  );

  it('opens a new session for the next round', async () => {
    scripted.reply(say(resultText(RESULT)), say(resultText(RESULT)));
    const agentId = await insertAgent();
    const first = await openDriverRound(options(agentId, await insertRound(1)));
    await first.birth;

    const second = await openDriverRound(
      options(agentId, await insertRound(2, 'active', 'Next goal.')),
    );
    await second.birth;

    expect(scripted.sessions.map((session) => session.sessionId)).toEqual([
      first.sessionId,
      second.sessionId,
    ]);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(scripted.prompts[1]?.text).toContain('Next goal.');
    expect(await agentRow(agentId)).toMatchObject({
      sessionId: second.sessionId,
      roundId: second.round.id,
    });
    expect((await turnRows(agentId)).map((row) => row.seq)).toEqual([1, 2]);
  });

  it('runs turns one at a time and marks the Driver working meanwhile', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scripted.reply(say(resultText(RESULT), { gate }), say(resultText(RESULT)));

    const round = await open();
    const next = round.turn('next');
    await expect.poll(() => scripted.prompts.length).toBe(1);
    expect((await agentRow(round.agent.id))?.status).toBe('working');
    release();
    await round.birth;
    await next;

    expect(scripted.maxConcurrent()).toBe(1);
    expect(scripted.prompts.map((prompt) => prompt.text)[1]).toBe('next');
    expect((await agentRow(round.agent.id))?.status).toBe('idle');
  });

  it(
    're-prompts once when the reply has no valid turn result',
    async () => {
      scripted.reply(say('I assigned the ticket.'), say(resultText(RESULT)));

      const round = await open();
      const birth = await round.birth;

      expect(birth.status).toBe('result');
      expect(birth.turns.map((turn) => turn.seq)).toEqual([1, 2]);
      const reprompt = scripted.prompts[1]?.text ?? '';
      expect(reprompt).toContain('the reply has no JSON object');
      expect(reprompt).toContain('```json');
      expect(scripted.prompts[1]?.sessionId).toBe(round.sessionId);
      expect(await events(TURN_EVENTS.missed)).toEqual([
        { seq: 1, error: 'the reply has no JSON object', reprompt: true },
      ]);
      expect(await events(TURN_EVENTS.result)).toEqual([
        { seq: 2, result: RESULT },
      ]);
      const dir = turnDir(turnsDir, round.agent.id, 1);
      expect(existsSync(turnFile(dir, 'result'))).toBe(false);
      expect(await readFile(turnFile(dir, 'output'), 'utf8')).toBe(
        'I assigned the ticket.',
      );
    },
    TIMEOUT,
  );

  it('gives up after one re-prompt and reports the miss', async () => {
    scripted.reply(
      say('No JSON here.'),
      say('```json\n{ "summary": "" }\n```'),
    );

    const round = await open();
    const birth = await round.birth;

    expect(birth.status).toBe('missed');
    expect(birth.status === 'missed' && birth.error).toContain('summary');
    expect(scripted.prompts).toHaveLength(2);
    expect(
      (await events(TURN_EVENTS.missed)).map((payload) => payload['reprompt']),
    ).toEqual([true, false]);
    expect(await events(TURN_EVENTS.result)).toEqual([]);
  });

  it('does not re-prompt a cancelled turn', async () => {
    scripted.reply(say('Working on it', { stopReason: 'cancelled' }));

    const round = await open();
    const birth = await round.birth;

    expect(birth).toMatchObject({ status: 'stopped', stopReason: 'cancelled' });
    expect(scripted.prompts).toHaveLength(1);
    expect(await events(TURN_EVENTS.stopped)).toEqual([
      { seq: 1, stopReason: 'cancelled' },
    ]);
  });

  it('closes a failed turn, records why and rejects', async () => {
    scripted.reply(say('Partial thought', { fail: 'agent crashed' }));

    const round = await open();

    await expect(round.birth).rejects.toThrow('agent crashed');
    const [row] = await turnRows(round.agent.id);
    expect(row).toMatchObject({ seq: 1, stopReason: null, ended: true });
    expect(await events(TURN_EVENTS.failed)).toEqual([
      { seq: 1, error: expect.stringContaining('agent crashed') },
    ]);
    expect((await agentRow(round.agent.id))?.status).toBe('idle');
    const dir = turnDir(turnsDir, round.agent.id, 1);
    expect(await readFile(turnFile(dir, 'output'), 'utf8')).toBe(
      'Partial thought',
    );

    scripted.reply(say(resultText(RESULT)));
    expect((await round.turn('try again')).status).toBe('result');
  });

  const stall = async (builderId: string, ticketId: string, head: string) => {
    const builder = { id: builderId, name: 'builder-idle' };
    for (let i = 0; i <= STUCK_AFTER_CONTINUES; i += 1) {
      await store.publish({
        kind: 'builder.continued',
        agentId: builderId,
        ticketId,
        payload: { name: builder.name, prompt: 'Keep going.', head },
      });
    }
    return flagIfStuck(store, builder, ticketId, head);
  };

  const insertTicket = async (): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title) values ($1, 'QD9 widget')
       returning id`,
      [store.projectId],
    );
    return rows[0]?.id ?? '';
  };

  it(
    'surfaces each stuck flag in the next Driver turn input, once',
    async () => {
      const builderId = await insertAgent('builder');
      const ticketId = await insertTicket();
      expect(await stall(builderId, ticketId, 'a'.repeat(40))).toBe(true);
      expect(
        await flagIfStuck(
          store,
          { id: builderId, name: 'b' },
          ticketId,
          'a'.repeat(40),
        ),
      ).toBe(false);
      scripted.reply(
        say(resultText(RESULT)),
        say(resultText(RESULT)),
        say('Working on it', { stopReason: 'cancelled' }),
        say('Partial thought', { fail: 'agent crashed' }),
        say(resultText(RESULT)),
      );

      const round = await open();
      await round.birth;
      const birth = scripted.prompts[0]?.text ?? '';
      expect(birth).toContain('# Stuck builders');
      expect(birth).toContain(
        `- builder-idle (${builderId}) on ticket ${ticketId} "QD9 widget", at ${'a'.repeat(40)}.`,
      );

      await round.turn('heron reported QD1.');
      expect(scripted.prompts[1]?.text).toBe('heron reported QD1.');

      expect(await stall(builderId, ticketId, 'b'.repeat(40))).toBe(true);
      expect((await round.turn('crane is idle.')).status).toBe('stopped');
      await expect(round.turn('reviewer-1 approved QD1.')).rejects.toThrow(
        'agent crashed',
      );
      await round.turn('try again');
      const resent = scripted.prompts.slice(2).map((prompt) => prompt.text);
      expect(resent).toHaveLength(3);
      for (const text of resent) {
        expect(text).toContain('# Stuck builders');
        expect(text).toContain(`at ${'b'.repeat(40)}.`);
        expect(text).not.toContain('a'.repeat(40));
      }
      expect(await unsurfacedStuckFlags(store)).toEqual([]);
      expect(
        (await events(STUCK_SURFACED_EVENT)).map((payload) => payload['flags']),
      ).toEqual([[expect.any(Number)], [expect.any(Number)]]);
    },
    TIMEOUT,
  );

  it('keeps a flag older than one already surfaced unsurfaced', async () => {
    const driverId = await insertAgent();
    const builderId = await insertAgent('builder');
    const ticketId = await insertTicket();
    await stall(builderId, ticketId, 'a'.repeat(40));
    await stall(builderId, ticketId, 'b'.repeat(40));
    const [older, newer] = await unsurfacedStuckFlags(store);
    if (!older || !newer) throw new Error('expected two flags');

    await markStuckFlagsSurfaced(store, { id: driverId }, [newer]);

    expect(await unsurfacedStuckFlags(store)).toEqual([older]);
  });

  const signInCards = async () => {
    const { rows } = await store.db.query<{
      id: string;
      agentId: string;
      kind: string;
      question: string;
      options: string[];
      recommendation: string;
      status: string;
    }>(
      `select id, agent_id as "agentId", kind, question, options,
              recommendation, status
       from cards where kind = $1 order by created_at`,
      [SIGN_IN_CARD],
    );
    return rows;
  };

  const openSignInCard = async () => {
    await expect
      .poll(async () =>
        (await signInCards()).filter((card) => card.status === 'open'),
      )
      .toHaveLength(1);
    const card = (await signInCards()).find((row) => row.status === 'open');
    if (!card) throw new Error('no open sign-in card');
    return card;
  };

  const settleCard = (cardId: string, status: string, answer: string | null) =>
    store.db.query(
      `update cards set status = $2, answer = $3, answered_at = now()
       where id = $1`,
      [cardId, status, answer],
    );

  it(
    'raises a sign-in card when the session needs sign-in and opens it once answered',
    async () => {
      await scripted.client.close();
      scripted = await startScriptedAgent({ authMethods: [CLAUDE_LOGIN] });
      scripted.requireSignIn(1);
      scripted.reply(say(resultText(RESULT)));
      const agentId = await insertAgent();
      await store.db.query(
        `update agents set runtime = 'claude' where id = $1`,
        [agentId],
      );
      const opening = openDriverRound(options(agentId, await insertRound(1)));

      const card = await openSignInCard();
      expect(card).toMatchObject({
        agentId,
        options: [SIGNED_IN],
        recommendation: CLAUDE_TERMINAL_COMMAND,
      });
      expect(card.question).toContain(`\`${CLAUDE_TERMINAL_COMMAND}\``);
      expect(await events(SIGN_IN_EVENTS.required)).toEqual([
        {
          cardId: card.id,
          runtime: 'claude',
          command: CLAUDE_TERMINAL_COMMAND,
          operation: 'session/new',
          error: expect.stringContaining('Authentication required'),
        },
      ]);
      expect(await events('card.asked')).toEqual([{ cardId: card.id }]);
      expect(scripted.sessions).toEqual([]);

      await settleCard(card.id, 'answered', SIGNED_IN);
      const round = await opening;

      expect((await round.birth).status).toBe('result');
      expect(scripted.sessionAttempts()).toBe(2);
      expect(scripted.sessions).toHaveLength(1);
      expect(launched).toEqual([agentId, agentId]);
      expect(await events(SIGN_IN_EVENTS.resumed)).toEqual([
        { cardId: card.id, runtime: 'claude', operation: 'session/new' },
      ]);
    },
    TIMEOUT,
  );

  it(
    'resends a prompt that needed sign-in in the same session once answered',
    async () => {
      scripted.reply(signInNeeded(), say(resultText(RESULT)));

      const round = await open();
      const card = await openSignInCard();
      expect(card.recommendation).toBe('kiro-cli login');
      expect(await events(SIGN_IN_EVENTS.required)).toEqual([
        expect.objectContaining({
          runtime: 'kiro',
          operation: 'session/prompt',
        }),
      ]);
      expect((await agentRow(round.agent.id))?.status).toBe('working');

      await settleCard(card.id, 'answered', SIGNED_IN);
      const birth = await round.birth;

      expect(birth).toMatchObject({
        status: 'result',
        turns: [expect.objectContaining({ seq: 1 })],
      });
      expect(scripted.prompts).toHaveLength(2);
      expect(scripted.prompts[1]).toEqual(scripted.prompts[0]);
      expect(scripted.sessions).toHaveLength(1);
      expect((await turnRows(round.agent.id)).map((row) => row.seq)).toEqual([
        1,
      ]);
      expect(await events(TURN_EVENTS.failed)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'asks again when the agent still needs sign-in after the answer',
    async () => {
      scripted.requireSignIn(2);
      scripted.reply(say(resultText(RESULT)));
      const opening = open();

      const first = await openSignInCard();
      await settleCard(first.id, 'answered', SIGNED_IN);
      const second = await openSignInCard();
      expect(second.id).not.toBe(first.id);
      await settleCard(second.id, 'answered', SIGNED_IN);

      expect((await (await opening).birth).status).toBe('result');
      expect(scripted.sessionAttempts()).toBe(3);
      expect(await events(SIGN_IN_EVENTS.required)).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    'fails the turn with the command to run when sign-in is declined',
    async () => {
      scripted.reply(signInNeeded());

      const round = await open();
      const card = await openSignInCard();
      await settleCard(card.id, 'declined', null);

      const failure = await round.birth.catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(SignInRequiredError);
      expect(failure).toMatchObject({
        runtime: 'kiro',
        command: 'kiro-cli login',
        cardId: card.id,
        status: 'declined',
      });
      expect(await events(TURN_EVENTS.failed)).toEqual([
        { seq: 1, error: expect.stringContaining('`kiro-cli login`') },
      ]);
      expect(await events(SIGN_IN_EVENTS.resumed)).toEqual([]);
      expect((await agentRow(round.agent.id))?.status).toBe('idle');
      expect(scripted.prompts).toHaveLength(1);
    },
    TIMEOUT,
  );

  it('refuses a round that has ended or does not exist', async () => {
    const agentId = await insertAgent();

    await expect(
      openDriverRound(options(agentId, await insertRound(1, 'ended'))),
    ).rejects.toBeInstanceOf(RoundEndedError);
    await expect(
      openDriverRound(options(agentId, '00000000-0000-4000-8000-000000000000')),
    ).rejects.toBeInstanceOf(RoundNotFoundError);
    expect(scripted.sessions).toEqual([]);
  });

  it('refuses an agent that is not a live Driver', async () => {
    const roundId = await insertRound(1);
    const builder = await insertAgent('builder');
    const retired = await insertAgent('driver', 'retired');

    await expect(
      openDriverRound(options(builder, roundId)),
    ).rejects.toBeInstanceOf(NotADriverError);
    await expect(
      openDriverRound(options(retired, roundId)),
    ).rejects.toBeInstanceOf(NotADriverError);
    expect(scripted.sessions).toEqual([]);
    expect(launched).toEqual([]);
  });

  it('holds the round launch while the project is paused and opens it on unpause', async () => {
    const setPaused = async (paused: boolean) => {
      await store.db.query(
        `update projects set paused_at = case when $2::boolean then now() end
         where id = $1`,
        [store.projectId, paused],
      );
      await store.publish({ kind: 'pause.set' });
    };
    await setPaused(true);
    scripted.reply(say(resultText(RESULT)));

    const opening = open();
    await settle(async () => {
      expect(await events('pause.held')).toHaveLength(1);
    });

    expect(await events('pause.held')).toEqual([
      {
        operation: 'launch',
        label: 'driver-idle, round 1',
        scopes: ['project'],
      },
    ]);
    expect(launched).toEqual([]);
    expect(scripted.sessions).toEqual([]);

    await setPaused(false);
    const round = await opening;

    expect((await round.birth).status).toBe('result');
    expect(launched).toEqual([round.agent.id]);
    expect(await events('pause.replayed')).toEqual([
      {
        operation: 'launch',
        label: 'driver-idle, round 1',
        heldEventId: expect.any(Number),
      },
    ]);
  });

  it('holds a turn while the Driver is paused and runs it, in order, on resume', async () => {
    scripted.reply(
      say(resultText(RESULT)),
      say(resultText(RESULT)),
      say(resultText(RESULT)),
    );
    const round = await open();
    await round.birth;
    await store.db.query(`update agents set status = 'paused' where id = $1`, [
      round.agent.id,
    ]);

    const first = round.turn('heron reported QD1.\nThe PR is open.');
    const second = round.turn('reviewer-1 approved QD1.');
    await settle(async () => {
      expect(await events('pause.held')).toHaveLength(1);
    });

    expect(await events('pause.held')).toEqual([
      {
        operation: 'driver.turn',
        label: 'turn: heron reported QD1.',
        scopes: ['agent'],
      },
    ]);
    expect(scripted.prompts).toHaveLength(1);
    expect((await agentRow(round.agent.id))?.status).toBe('paused');

    await store.db.query(`update agents set status = 'idle' where id = $1`, [
      round.agent.id,
    ]);
    await store.publish({ kind: 'agent.resume', agentId: round.agent.id });
    await first;
    await second;

    expect(scripted.prompts.slice(1).map((prompt) => prompt.text)).toEqual([
      'heron reported QD1.\nThe PR is open.',
      'reviewer-1 approved QD1.',
    ]);
    expect(await events('pause.held')).toHaveLength(1);
  });

  it('holds a round at the budget line before launching the bus or a session', async () => {
    const agentId = await insertAgent();
    const roundId = await insertRound(1);
    await store.db.query(
      `insert into turns (agent_id, seq, prompt, input_tokens, output_tokens,
                          ended_at)
       values ($1, 1, 'go', 600, 200, now())`,
      [agentId],
    );
    const capped: DriverRoundOptions = {
      ...options(agentId, roundId),
      budget: { hours: 5, capTokens: 1000, holdAtFraction: 0.8 },
    };

    await expect(openDriverRound(capped)).rejects.toBeInstanceOf(
      BudgetHeldError,
    );
    expect(scripted.sessions).toEqual([]);
    expect(launched).toEqual([]);
    expect(await events('budget.held')).toEqual([
      expect.objectContaining({ usedTokens: 800, holdAtTokens: 800 }),
    ]);
    expect(await events(ROUND_STARTED_EVENT)).toEqual([]);
  });
});
