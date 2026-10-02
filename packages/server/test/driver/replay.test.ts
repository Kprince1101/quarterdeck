import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  REPLAY_COMMAND,
  TurnInputMissingError,
  openDriverRound,
  readTurnChain,
  replayCommand,
  replayDriverChain,
  turnDir,
  turnFile,
  type ReplayTurn,
} from '../../src/driver/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from './scripted-agent.js';

const TIMEOUT = 30_000;
const AGENT_ID = '7d0f3a4e-2b1c-4c5d-9e8f-0a1b2c3d4e5f';
const BIRTH = { summary: 'Nothing to assign yet.', actions: [] };
const ASSIGNED = {
  summary: 'Assigned QD12 to heron.',
  actions: [{ kind: 'assign', ticket: 'QD12' }],
};
const BUS: McpServerStdio = {
  name: 'quarterdeck',
  command: 'node',
  args: ['relay.js'],
  env: [],
};

const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path] = await readFile(path, 'utf8');
  }
  return files;
};

describe('Driver replay', () => {
  let scripted: ScriptedAgent;
  let turnsDir: string;

  beforeEach(async () => {
    scripted = await startScriptedAgent();
    turnsDir = await mkdtemp(join(tmpdir(), 'qd-replay-'));
  });

  afterEach(async () => {
    await scripted.client.close();
    await rm(turnsDir, { recursive: true, force: true });
  });

  const save = async (seq: number, input: string, output?: string) => {
    const dir = turnDir(turnsDir, AGENT_ID, seq);
    await mkdir(dir, { recursive: true });
    await writeFile(turnFile(dir, 'input'), input);
    if (output !== undefined) await writeFile(turnFile(dir, 'output'), output);
  };

  describe('against a recorded round', () => {
    let store: Store;

    beforeAll(async () => {
      store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
    }, TIMEOUT);

    afterAll(async () => {
      await store.close();
    });

    const count = async (table: string): Promise<number> => {
      const { rows } = await store.db.query<{ n: number }>(
        `select count(*)::int as n from ${table}`,
      );
      return rows[0]?.n ?? 0;
    };

    it(
      'sends turns 1..n from their saved inputs in one new session and writes nothing',
      async () => {
        const { rows: rounds } = await store.db.query<{ id: string }>(
          `insert into rounds (project_id, number, status, goal)
           values ($1, 1, 'active', 'Ship replay.') returning id`,
          [store.projectId],
        );
        const { rows: agents } = await store.db.query<{ id: string }>(
          `insert into agents (project_id, name, role, status)
           values ($1, 'newt', 'driver', 'idle') returning id`,
          [store.projectId],
        );
        const agentId = agents[0]?.id ?? '';
        scripted.reply(
          say(resultText(BIRTH)),
          say('No JSON here.'),
          say(resultText(ASSIGNED)),
          say(resultText(BIRTH)),
        );
        const round = await openDriverRound({
          store,
          client: scripted.client,
          bus: { launch: async () => BUS },
          agentId,
          roundId: rounds[0]?.id ?? '',
          cwd: '/work/deck',
          charter: '# Driver charter',
          turnsDir,
        });
        await round.birth;
        await round.turn('heron reported QD12.');
        await round.turn('Round goal changed.');
        const recorded = scripted.prompts.map((prompt) => prompt.text);
        expect(recorded).toHaveLength(4);

        const files = await snapshot(turnsDir);
        const turns = await count('turns');
        const events = await count('events');
        const agentBefore = await store.db.query(
          'select * from agents where id = $1',
          [agentId],
        );

        const replayer = await startScriptedAgent();
        try {
          replayer.reply(
            say(resultText(BIRTH)),
            say('Still no JSON.'),
            say(resultText(BIRTH)),
          );
          const seen: number[] = [];
          const replay = await replayDriverChain({
            client: replayer.client,
            cwd: '/work/deck',
            turnsDir,
            agentId,
            through: 3,
            onTurn: (turn) => seen.push(turn.seq),
          });

          expect(replayer.sessions).toEqual([
            { sessionId: replay.sessionId, cwd: '/work/deck', mcpServers: [] },
          ]);
          expect(replayer.prompts).toEqual(
            recorded.slice(0, 3).map((text) => ({
              sessionId: replay.sessionId,
              text,
            })),
          );
          expect(seen).toEqual([1, 2, 3]);
          expect(replay.turns).toEqual<ReplayTurn[]>([
            {
              seq: 1,
              input: recorded[0] ?? '',
              savedOutput: resultText(BIRTH),
              output: resultText(BIRTH),
              stopReason: 'end_turn',
              result: { ok: true, value: BIRTH },
            },
            {
              seq: 2,
              input: recorded[1] ?? '',
              savedOutput: 'No JSON here.',
              output: 'Still no JSON.',
              stopReason: 'end_turn',
              result: { ok: false, error: 'the reply has no JSON object' },
            },
            {
              seq: 3,
              input: recorded[2] ?? '',
              savedOutput: resultText(ASSIGNED),
              output: resultText(BIRTH),
              stopReason: 'end_turn',
              result: { ok: true, value: BIRTH },
            },
          ]);
        } finally {
          await replayer.client.close();
        }

        expect(await snapshot(turnsDir)).toEqual(files);
        expect(await count('turns')).toBe(turns);
        expect(await count('events')).toBe(events);
        expect(
          (
            await store.db.query('select * from agents where id = $1', [
              agentId,
            ])
          ).rows,
        ).toEqual(agentBefore.rows);
      },
      TIMEOUT,
    );
  });

  it('keeps the replay text separate per turn and reports stop reasons', async () => {
    await save(1, 'birth', resultText(BIRTH));
    await save(2, 'poke');
    scripted.reply(say(resultText(BIRTH)), {
      chunks: ['I will not.'],
      stopReason: 'refusal',
    });

    const replay = await replayDriverChain({
      client: scripted.client,
      cwd: '/work/deck',
      turnsDir,
      agentId: AGENT_ID,
      through: 2,
    });

    expect(replay.turns[1]).toEqual({
      seq: 2,
      input: 'poke',
      savedOutput: null,
      output: 'I will not.',
      stopReason: 'refusal',
      result: { ok: false, error: 'the reply has no JSON object' },
    });
  });

  it('opens no session when an input in 1..n is missing', async () => {
    await save(1, 'birth');
    await save(3, 'third');

    const replay = replayDriverChain({
      client: scripted.client,
      cwd: '/work/deck',
      turnsDir,
      agentId: AGENT_ID,
      through: 3,
    });

    await expect(replay).rejects.toBeInstanceOf(TurnInputMissingError);
    await expect(replay).rejects.toMatchObject({
      agentId: AGENT_ID,
      seq: 2,
      path: turnFile(turnDir(turnsDir, AGENT_ID, 2), 'input'),
    });
    expect(scripted.sessions).toEqual([]);
  });

  it('rejects when a prompt fails and still writes nothing', async () => {
    await save(1, 'birth');
    await save(2, 'poke');
    scripted.reply(say(resultText(BIRTH)), { fail: 'agent died' });

    await expect(
      replayDriverChain({
        client: scripted.client,
        cwd: '/work/deck',
        turnsDir,
        agentId: AGENT_ID,
        through: 2,
      }),
    ).rejects.toThrow('agent died');
    expect(await snapshot(turnsDir)).toEqual({
      [turnFile(turnDir(turnsDir, AGENT_ID, 1), 'input')]: 'birth',
      [turnFile(turnDir(turnsDir, AGENT_ID, 2), 'input')]: 'poke',
    });
  });

  it('reads only turns 1..n', async () => {
    await save(1, 'birth', 'reply one');
    await save(2, 'poke');
    await save(3, 'later');

    expect(
      await readTurnChain({ turnsDir, agentId: AGENT_ID, through: 2 }),
    ).toEqual([
      {
        seq: 1,
        dir: turnDir(turnsDir, AGENT_ID, 1),
        input: 'birth',
        output: 'reply one',
      },
      {
        seq: 2,
        dir: turnDir(turnsDir, AGENT_ID, 2),
        input: 'poke',
        output: null,
      },
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses n = %s', async (through) => {
    await expect(
      readTurnChain({ turnsDir, agentId: AGENT_ID, through }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it.each(['../other', 'not-a-uuid', ''])(
    'refuses agent id %j',
    async (agentId) => {
      await expect(
        readTurnChain({ turnsDir, agentId, through: 1 }),
      ).rejects.toThrow('Invalid agent id');
    },
  );
});

describe('replayCommand', () => {
  it('prints the command the dashboard shows for turns 1..n', () => {
    expect(
      replayCommand({ project: 'commander', agentId: AGENT_ID, through: 7 }),
    ).toBe(`${REPLAY_COMMAND} commander ${AGENT_ID} 7`);
    expect(REPLAY_COMMAND).toBe('npx quarterdeck replay');
  });

  it('refuses parts that are not safe to paste into a shell', () => {
    expect(() =>
      replayCommand({ project: 'a; rm -rf ~', agentId: AGENT_ID, through: 1 }),
    ).toThrow('Invalid project slug');
    expect(() =>
      replayCommand({ project: 'deck', agentId: '$(id)', through: 1 }),
    ).toThrow('Invalid agent id');
    expect(() =>
      replayCommand({ project: 'deck', agentId: AGENT_ID, through: 0 }),
    ).toThrow(RangeError);
  });
});
