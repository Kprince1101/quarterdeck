import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
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
  openDriverRound,
  unsurfacedStuckFlags,
  turnDir,
  turnFile,
  type DriverRound,
  type DriverRoundOptions,
} from '../../src/driver/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from './scripted-agent.js';

const TIMEOUT = 30_000;
const CHARTER = '# Driver charter\n\nTurn tickets into merged pull requests.';
const RESULT = { summary: 'Nothing to assign yet.', actions: [] };
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
  });

  afterEach(async () => {
    await scripted.client.close();
    await rm(turnsDir, { recursive: true, force: true });
    await store.db.exec(
      `delete from events; delete from turns; delete from notebook;
       delete from tickets; delete from agents; delete from rounds;`,
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
        'Reviews go to thimble.',
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
        input.indexOf('Reviews go to thimble.'),
      );
      expect(input.indexOf('Reviews go to thimble.')).toBeLessThan(
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
      const third = await round.turn('thimble approved QD1.');

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
        'thimble approved QD1.',
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
    for (let i = 0; i < STUCK_AFTER_CONTINUES; i += 1) {
      await store.publish({
        kind: 'builder.continued',
        agentId: builderId,
        ticketId,
        payload: { name: builder.name, prompt: 'Keep going.', head },
      });
    }
    return flagIfStuck(store, builder, ticketId, head);
  };

  it(
    'surfaces each stuck flag in the next Driver turn input, once',
    async () => {
      const builderId = await insertAgent('builder');
      const { rows } = await store.db.query<{ id: string }>(
        `insert into tickets (project_id, title) values ($1, 'QD9 widget')
         returning id`,
        [store.projectId],
      );
      const ticketId = rows[0]?.id ?? '';
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
      await expect(round.turn('thimble approved QD1.')).rejects.toThrow(
        'agent crashed',
      );
      await round.turn('try again');
      const [failed, retried] = scripted.prompts
        .slice(2)
        .map((prompt) => prompt.text);
      for (const text of [failed, retried]) {
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
});
