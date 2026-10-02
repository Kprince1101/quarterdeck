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
import type {
  McpServerStdio,
  PermissionOption,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
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
  CANCELLED_PERMISSION,
  connectAcpClient,
} from '../../src/acp/client/index.js';
import {
  DRIVER_TURN_INSTRUCTIONS,
  NoBirthTurnError,
  REPLAY_COMMAND,
  REPLAY_PERMISSIONS,
  TurnInputMissingError,
  buildBirthInput,
  isBirthInput,
  openDriverRound,
  readTurnChain,
  replayCommand,
  replayDriverChain,
  repromptText,
  turnDir,
  turnFile,
  type ConnectReplay,
  type ReplaySetup,
  type ReplayTurn,
} from '../../src/driver/index.js';
import { pathExists } from '../../src/lib/fs.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import { connectFakeAgentInProcess } from '../acp/fake-agent/index.ts';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
  type ScriptedReply,
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

const birthInput = (round: number): string =>
  buildBirthInput({
    agent: { name: 'newt' },
    round: { number: round, goal: `Goal ${round}.` },
    charter: '# Driver charter',
    notebook: [],
    instructions: DRIVER_TURN_INSTRUCTIONS,
  });

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

interface Connection {
  setup: ReplaySetup;
  agent: ScriptedAgent;
  closed: boolean;
}

const scriptedConnect = (...replies: ScriptedReply[]) => {
  const connections: Connection[] = [];
  const connect: ConnectReplay = async (setup) => {
    const agent = await startScriptedAgent(setup.onPermissionRequest);
    agent.reply(...replies);
    const connection: Connection = { setup, agent, closed: false };
    connections.push(connection);
    const { client } = agent;
    return {
      newSession: client.newSession.bind(client),
      prompt: client.prompt.bind(client),
      subscribe: client.subscribe.bind(client),
      close: async () => {
        connection.closed = true;
        await client.close();
      },
    };
  };
  return { connect, connections };
};

describe('Driver replay', () => {
  let turnsDir: string;

  beforeEach(async () => {
    turnsDir = await mkdtemp(join(tmpdir(), 'qd-replay-'));
  });

  afterEach(async () => {
    await rm(turnsDir, { recursive: true, force: true });
  });

  const save = async (seq: number, input: string, output?: string) => {
    const dir = turnDir(turnsDir, AGENT_ID, seq);
    await mkdir(dir, { recursive: true });
    await writeFile(turnFile(dir, 'input'), input);
    if (output !== undefined) await writeFile(turnFile(dir, 'output'), output);
  };

  const chain = (through: number) => ({
    turnsDir,
    agentId: AGENT_ID,
    through,
  });

  describe('against the store', () => {
    let store: Store;

    beforeAll(async () => {
      store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
    }, TIMEOUT);

    afterAll(async () => {
      await store.close();
    });

    afterEach(async () => {
      await store.db.exec(
        `delete from events; delete from turns; delete from cards;
         delete from agents; delete from rounds;`,
      );
    });

    const count = async (table: string): Promise<number> => {
      const { rows } = await store.db.query<{ n: number }>(
        `select count(*)::int as n from ${table}`,
      );
      return rows[0]?.n ?? 0;
    };

    const counts = async () => ({
      turns: await count('turns'),
      events: await count('events'),
      cards: await count('cards'),
    });

    it(
      'sends a recorded round from its saved inputs in one new session and writes nothing',
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
        const recorder = await startScriptedAgent();
        recorder.reply(
          say(resultText(BIRTH)),
          say('No JSON here.'),
          say(resultText(ASSIGNED)),
          say(resultText(BIRTH)),
        );
        const round = await openDriverRound({
          store,
          client: recorder.client,
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
        await recorder.client.close();
        const recorded = recorder.prompts.map((prompt) => prompt.text);
        expect(recorded).toHaveLength(4);

        const files = await snapshot(turnsDir);
        const before = await counts();
        const agentBefore = await store.db.query(
          'select * from agents where id = $1',
          [agentId],
        );

        const { connect, connections } = scriptedConnect(
          say(resultText(BIRTH)),
          say('Still no JSON.'),
          say(resultText(BIRTH)),
        );
        const seen: number[] = [];
        const replay = await replayDriverChain({
          connect,
          turnsDir,
          agentId,
          through: 3,
          onTurn: (turn) => seen.push(turn.seq),
        });

        expect(connections).toHaveLength(1);
        const [connection] = connections;
        const cwd = connection?.setup.cwd ?? '';
        expect(cwd.startsWith(join(tmpdir(), 'quarterdeck-replay-'))).toBe(
          true,
        );
        expect(connection?.setup.onPermissionRequest).toBe(REPLAY_PERMISSIONS);
        expect(connection?.agent.sessions).toEqual([
          { sessionId: replay.sessionId, cwd, mcpServers: [] },
        ]);
        expect(connection?.agent.prompts).toEqual(
          recorded.slice(0, 3).map((text) => ({
            sessionId: replay.sessionId,
            text,
          })),
        );
        expect(connection?.closed).toBe(true);
        expect(await pathExists(cwd)).toBe(false);
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

        expect(await snapshot(turnsDir)).toEqual(files);
        expect(await counts()).toEqual(before);
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

    it(
      'rejects every permission the replayed agent asks for, with no card or event',
      async () => {
        await save(1, birthInput(1));
        await save(2, 'permission', 'permission granted: allow-once');
        const before = await counts();
        const answered: RequestPermissionResponse[] = [];
        const connect: ConnectReplay = async (setup) => {
          const client = await connectAcpClient({
            stream: connectFakeAgentInProcess(),
            options: {
              clientName: 'replay-test',
              clientVersion: '0.0.0',
              onPermissionRequest: setup.onPermissionRequest,
            },
          });
          client.subscribe((event) => {
            if (event.type === 'permission') answered.push(event.response);
          });
          return client;
        };

        const replay = await replayDriverChain({
          ...chain(2),
          connect,
        });

        expect(replay.turns[1]).toMatchObject({
          seq: 2,
          savedOutput: 'permission granted: allow-once',
          output: 'permission rejected: reject-once',
          stopReason: 'end_turn',
        });
        expect(answered).toEqual([
          { outcome: { outcome: 'selected', optionId: 'reject-once' } },
        ]);
        expect(await counts()).toEqual(before);
      },
      TIMEOUT,
    );
  });

  it('starts at the latest birth at or before n, so one round is replayed', async () => {
    await save(1, birthInput(1));
    await save(2, 'poke one');
    await save(3, birthInput(2));
    await save(4, 'poke two');
    await save(5, repromptText('no JSON', DRIVER_TURN_INSTRUCTIONS));

    expect((await readTurnChain(chain(5))).map((turn) => turn.seq)).toEqual([
      3, 4, 5,
    ]);
    expect((await readTurnChain(chain(3))).map((turn) => turn.seq)).toEqual([
      3,
    ]);
    expect((await readTurnChain(chain(2))).map((turn) => turn.seq)).toEqual([
      1, 2,
    ]);

    const { connect, connections } = scriptedConnect(
      say(resultText(BIRTH)),
      say(resultText(BIRTH)),
    );
    await replayDriverChain({ ...chain(4), connect });
    expect(connections[0]?.agent.prompts.map((prompt) => prompt.text)).toEqual([
      birthInput(2),
      'poke two',
    ]);
  });

  it('refuses a chain with no birth input at or before n', async () => {
    await save(1, 'poke');
    await save(2, 'poke again');
    const { connect, connections } = scriptedConnect();

    await expect(
      replayDriverChain({ ...chain(2), connect }),
    ).rejects.toBeInstanceOf(NoBirthTurnError);
    expect(connections).toEqual([]);
  });

  it('reports stop reasons and a missing saved output', async () => {
    await save(1, birthInput(1), resultText(BIRTH));
    await save(2, 'poke');
    const { connect } = scriptedConnect(say(resultText(BIRTH)), {
      chunks: ['I will not.'],
      stopReason: 'refusal',
    });

    const replay = await replayDriverChain({ ...chain(2), connect });

    expect(replay.turns[1]).toEqual({
      seq: 2,
      input: 'poke',
      savedOutput: null,
      output: 'I will not.',
      stopReason: 'refusal',
      result: { ok: false, error: 'the reply has no JSON object' },
    });
  });

  it('connects nothing when an input in the chain is missing', async () => {
    await save(1, birthInput(1));
    await save(3, 'third');
    const { connect, connections } = scriptedConnect();

    const replay = replayDriverChain({ ...chain(3), connect });

    await expect(replay).rejects.toBeInstanceOf(TurnInputMissingError);
    await expect(replay).rejects.toMatchObject({
      agentId: AGENT_ID,
      seq: 2,
      path: turnFile(turnDir(turnsDir, AGENT_ID, 2), 'input'),
    });
    expect(connections).toEqual([]);
  });

  it('closes its client and removes its directory when a prompt fails', async () => {
    await save(1, birthInput(1));
    await save(2, 'poke');
    const files = await snapshot(turnsDir);
    const { connect, connections } = scriptedConnect(say(resultText(BIRTH)), {
      fail: 'agent died',
    });

    await expect(replayDriverChain({ ...chain(2), connect })).rejects.toThrow(
      'agent died',
    );
    expect(connections[0]?.closed).toBe(true);
    expect(await pathExists(connections[0]?.setup.cwd ?? '')).toBe(false);
    expect(await snapshot(turnsDir)).toEqual(files);
  });

  it('runs in a cwd the caller names and leaves it in place', async () => {
    await save(1, birthInput(1));
    const cwd = await mkdtemp(join(tmpdir(), 'qd-replay-cwd-'));
    try {
      const { connect, connections } = scriptedConnect(say(resultText(BIRTH)));

      await replayDriverChain({ ...chain(1), connect, cwd });

      expect(connections[0]?.setup.cwd).toBe(cwd);
      expect(connections[0]?.agent.sessions[0]?.cwd).toBe(cwd);
      expect(await pathExists(cwd)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses n = %s', async (through) => {
    await expect(readTurnChain(chain(through))).rejects.toBeInstanceOf(
      RangeError,
    );
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

describe('REPLAY_PERMISSIONS', () => {
  const request = (options: PermissionOption[]) => ({
    sessionId: 'replay-1',
    toolCall: { toolCallId: 'call-1', title: 'git push' },
    options,
  });

  it('picks a reject option and never an allow one', async () => {
    await expect(
      REPLAY_PERMISSIONS(
        request([
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'never', name: 'Never', kind: 'reject_always' },
        ]),
      ),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'never' } });
  });

  it('cancels when there is nothing to reject with', async () => {
    await expect(
      REPLAY_PERMISSIONS(
        request([{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]),
      ),
    ).resolves.toEqual(CANCELLED_PERMISSION);
  });
});

describe('isBirthInput', () => {
  it('tells a birth input from the prompts that follow it', () => {
    expect(isBirthInput(birthInput(3))).toBe(true);
    expect(isBirthInput('heron reported QD12.')).toBe(false);
    expect(
      isBirthInput(repromptText('no JSON', DRIVER_TURN_INSTRUCTIONS)),
    ).toBe(false);
  });
});

describe('replayCommand', () => {
  it('prints the command the dashboard shows for a turn', () => {
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
