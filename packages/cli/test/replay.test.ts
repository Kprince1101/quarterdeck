import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { RequestError } from '@agentclientprotocol/sdk';
import { forgeTerms, type Runtime } from '@quarterdeck/rules';
import {
  DRIVER_TURN_INSTRUCTIONS,
  REPLAY_PERMISSIONS,
  buildBirthInput,
  projectTurnsDir,
  quarterdeckHome,
  replayCommand,
  turnDir,
  turnFile,
  type AcpClientListener,
  type AcpClientOptions,
  type ReplayClient,
  type RuntimeLaunch,
} from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPLAY_USAGE,
  USAGE,
  main,
  replayVoyage,
  type ReplayAdapters,
} from '../src/index.js';
import { sandbox, testIo, type Sandbox, type TestIo } from './harness.js';

const DRIVER = '7d0f3a4e-2b1c-4c5d-9e8f-0a1b2c3d4e5f';
const OLD_DRIVER = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const BUILDER = '11111111-2222-4333-8444-555555555555';
const RESULT = '```json\n{ "summary": "Nothing to do.", "actions": [] }\n```';
const NO_SERVICES = {
  forge: { forge: 'github', host: null },
  tracker: null,
} as const;

const birthInput = (voyage: number, name = 'driver-1'): string =>
  buildBirthInput({
    agent: { name },
    voyage: { number: voyage, goal: `Goal ${voyage}.` },
    charter: '# Driver charter',
    notebook: [],
    instructions: DRIVER_TURN_INSTRUCTIONS,
  });

type Reply = string | Error | ((client: FakeConnection) => Promise<string>);

interface FakeConnection {
  runtime: Runtime;
  launch: RuntimeLaunch;
  options: AcpClientOptions;
  sessions: string[];
  prompts: string[];
  closed: boolean;
}

const fakeAdapters = (...replies: Reply[]) => {
  const connections: FakeConnection[] = [];
  const queue = [...replies];
  const adapter =
    (runtime: Runtime) =>
    async (
      launch: RuntimeLaunch,
      options: AcpClientOptions,
    ): Promise<ReplayClient> => {
      const connection: FakeConnection = {
        runtime,
        launch,
        options,
        sessions: [],
        prompts: [],
        closed: false,
      };
      connections.push(connection);
      const listeners = new Set<AcpClientListener>();
      return {
        agent: {
          protocolVersion: 1,
          authMethods: [{ id: 'login', name: 'Log in' }],
        },
        newSession: async (setup) => {
          connection.sessions.push(setup.cwd);
          return { sessionId: 'replay-1' };
        },
        prompt: async (sessionId, input) => {
          if (connection.closed) throw new Error('client closed');
          connection.prompts.push(String(input));
          const reply = queue.shift() ?? RESULT;
          if (reply instanceof Error) throw reply;
          let text = reply;
          if (typeof text === 'function') text = await text(connection);
          for (const listener of listeners) {
            listener({
              type: 'session_update',
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text },
              },
            });
          }
          return { stopReason: 'end_turn' };
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: async () => {
          connection.closed = true;
        },
      };
    };
  const adapters: ReplayAdapters = {
    kiro: { connect: adapter('kiro') },
    claude: { connect: adapter('claude') },
    gemini: { connect: adapter('gemini') },
  };
  return { adapters, connections };
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

describe('quarterdeck replay', () => {
  let box: Sandbox;
  let io: TestIo;
  let home: string;

  beforeEach(async () => {
    box = await sandbox();
    io = testIo(box.home);
    home = quarterdeckHome(box.home);
  });

  afterEach(async () => {
    await box.close();
  });

  const save = async (
    project: string,
    agentId: string,
    seq: number,
    input: string,
    output?: string,
  ) => {
    const dir = turnDir(projectTurnsDir(project, home), agentId, seq);
    await mkdir(dir, { recursive: true });
    await writeFile(turnFile(dir, 'input'), input);
    if (output !== undefined) await writeFile(turnFile(dir, 'output'), output);
    return turnFile(dir, 'input');
  };

  const saveVoyages = async (project = 'deck') => {
    await save(project, DRIVER, 1, birthInput(1), RESULT);
    await save(project, DRIVER, 2, 'heron reported QD1.', RESULT);
    await save(project, DRIVER, 3, birthInput(2), RESULT);
    await save(project, DRIVER, 4, 'heron reported QD2.', 'Old reply.');
    await save(project, DRIVER, 5, 'Voyage goal changed.');
    await save(project, DRIVER, 6, birthInput(3));
    await save(project, BUILDER, 1, 'Work on QD2.');
  };

  it("replays a voyage's Driver turns from its birth in one session, writing nothing", async () => {
    await saveVoyages();
    const before = await snapshot(home);
    const { adapters, connections } = fakeAdapters(RESULT, 'No JSON.');

    const code = await replayVoyage(['2', '--runtime', 'claude'], io, {
      adapters,
    });

    expect(io.errors).toEqual([]);
    expect(code).toBe(0);
    expect(connections).toHaveLength(1);
    const [connection] = connections;
    expect(connection?.runtime).toBe('claude');
    expect(connection?.launch).toEqual({
      cwd: connection?.sessions[0],
      env: { pass: [] },
      project: 'deck',
      agentName: 'replay-5',
    });
    expect(connection?.options).toMatchObject({
      clientName: 'quarterdeck',
      onPermissionRequest: REPLAY_PERMISSIONS,
    });
    expect(connection?.prompts).toEqual([
      birthInput(2),
      'heron reported QD2.',
      'Voyage goal changed.',
    ]);
    expect(connection?.closed).toBe(true);
    expect(connection?.launch.cwd).not.toContain(box.home);
    expect(await snapshot(home)).toEqual(before);
    expect(io.lines).toEqual([
      `Replaying voyage 2 of deck: Driver driver-1 (${DRIVER}), turns 1 to 3 of 3, on claude.`,
      'Nothing is saved. The agent has no Quarterdeck tools and every permission is refused.',
      '',
      '--- Turn 1 of 3 ---',
      RESULT,
      '(end_turn; turn result parsed; same as the saved reply)',
      '',
      '--- Turn 2 of 3 ---',
      'No JSON.',
      '(end_turn; no turn result (the reply has no JSON object); differs from the saved reply)',
      '',
      '--- Turn 3 of 3 ---',
      RESULT,
      '(end_turn; turn result parsed; no saved reply)',
      '',
      'Replayed 3 turns.',
    ]);
  });

  it('stops at turn n of the voyage', async () => {
    await saveVoyages();
    const { adapters, connections } = fakeAdapters();

    const code = await replayVoyage(['2', '2', '--runtime', 'kiro'], io, {
      adapters,
    });

    expect(code).toBe(0);
    expect(connections[0]?.prompts).toEqual([
      birthInput(2),
      'heron reported QD2.',
    ]);
    expect(connections[0]?.launch.agentName).toBe('replay-4');
    expect(io.lines.at(-1)).toBe('Replayed 2 turns.');
  });

  it("uses the Driver's runtime from the machine's models rule by default", async () => {
    await saveVoyages();
    await writeFile(
      join(home, 'rules.local.models.json'),
      JSON.stringify({ driver: { runtime: 'gemini' } }),
    );
    const { adapters, connections } = fakeAdapters();

    expect(await replayVoyage(['1'], io, { adapters })).toBe(0);
    expect(connections[0]?.runtime).toBe('gemini');
  });

  it('replays the latest Driver session when a voyage had more than one', async () => {
    const earlier = await save('deck', OLD_DRIVER, 1, birthInput(1, 'lark'));
    await utimes(earlier, new Date('2026-01-01'), new Date('2026-01-01'));
    await save('deck', DRIVER, 1, birthInput(1));
    const { adapters } = fakeAdapters();

    expect(
      await replayVoyage(['1', '--runtime', 'kiro'], io, { adapters }),
    ).toBe(0);
    expect(io.lines.slice(0, 2)).toEqual([
      `Replaying voyage 1 of deck: Driver driver-1 (${DRIVER}), turns 1 to 1 of 1, on kiro.`,
      'Voyage 1 had 2 Driver sessions; this is the latest.',
    ]);
  });

  it('asks for --project when the voyage is in more than one project', async () => {
    await saveVoyages('deck');
    await saveVoyages('fleet');
    const { adapters, connections } = fakeAdapters();

    await expect(
      replayVoyage(['1', '--runtime', 'kiro'], io, { adapters }),
    ).rejects.toThrow(
      'Voyage 1 is in more than one project (deck, fleet). Pass --project <slug>.',
    );
    expect(connections).toEqual([]);

    const code = await replayVoyage(
      ['1', '--runtime', 'kiro', '--project', 'fleet'],
      io,
      { adapters },
    );
    expect(code).toBe(0);
    expect(connections[0]?.launch.project).toBe('fleet');
  });

  it('finds a voyage across every project without --project', async () => {
    await saveVoyages('deck');
    await save(
      'fleet',
      DRIVER,
      1,
      buildBirthInput({
        agent: { name: 'lark' },
        voyage: { number: 4, goal: 'Ship both.' },
        charter: '# Driver charter',
        notebook: [],
        projects: [
          {
            project: 'deck',
            repoPath: '/repos/deck',
            bus: 'bus-deck',
            terms: forgeTerms('github'),
            waiting: [],
            builders: [],
            services: NO_SERVICES,
          },
          {
            project: 'fleet',
            repoPath: '/repos/fleet',
            bus: 'bus-fleet',
            terms: forgeTerms('github'),
            waiting: [],
            builders: [],
            services: NO_SERVICES,
          },
        ],
        instructions: DRIVER_TURN_INSTRUCTIONS,
      }),
    );
    await save('deck', BUILDER, 2, 'Work on QD4.');
    const { adapters } = fakeAdapters();

    expect(
      await replayVoyage(['4', '--runtime', 'kiro'], io, { adapters }),
    ).toBe(0);
    expect(io.lines[0]).toBe(
      `Replaying voyage 4 of fleet: Driver lark (${DRIVER}), turns 1 to 1 of 1, on kiro.`,
    );
  });

  it('runs the command the Driver widget prints', async () => {
    await saveVoyages();
    const { adapters, connections } = fakeAdapters();
    const [, , ...args] = replayCommand({
      voyage: 2,
      through: 1,
      project: 'deck',
    }).split(' ');

    expect(args).toEqual(['replay', '2', '1', '--project', 'deck']);
    const code = await replayVoyage(
      [...args.slice(1), '--runtime', 'kiro'],
      io,
      { adapters },
    );
    expect(code).toBe(0);
    expect(connections[0]?.prompts).toEqual([birthInput(2)]);
  });

  it('exits 1 with the sign-in command when the runtime needs sign-in', async () => {
    await saveVoyages();
    const { adapters, connections } = fakeAdapters(RequestError.authRequired());

    const code = await replayVoyage(['1', '--runtime', 'claude'], io, {
      adapters,
    });

    expect(code).toBe(1);
    expect(connections[0]?.closed).toBe(true);
    expect(io.errors).toHaveLength(2);
    expect(io.errors[0]).toMatch(/is not signed in; run `.+` to sign in/);
    expect(io.errors[1]).toMatch(/^Sign in: \S/);
    expect(io.errors[0]).toContain(
      `\`${io.errors[1]?.slice('Sign in: '.length)}\``,
    );
  });

  it('closes the agent and cancels when stopped mid-replay', async () => {
    await saveVoyages();
    let closedWhileRunning = false;
    const { adapters, connections } = fakeAdapters(async (connection) => {
      io.stop();
      await setTimeout(10);
      closedWhileRunning = connection.closed;
      return RESULT;
    });

    await expect(
      replayVoyage(['2', '--runtime', 'kiro'], io, { adapters }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(closedWhileRunning).toBe(true);
    expect(connections[0]?.prompts).toHaveLength(1);
    expect(io.lines).not.toContain('Replayed 3 turns.');
  });

  it.each([
    [['0'], 'voyage must be a positive whole number, not 0'],
    [['1', 'x'], 'n must be a positive whole number, not x'],
    [['1', '2', '3'], 'replay takes a voyage and n'],
    [['1', '--project', '../x'], '--project "../x" is not a project slug'],
    [
      ['1', '--runtime', 'vim'],
      '--runtime must be one of kiro, claude, gemini',
    ],
  ])('refuses %j', async (args, message) => {
    await saveVoyages();
    const { adapters, connections } = fakeAdapters();

    await expect(replayVoyage(args, io, { adapters })).rejects.toThrow(message);
    expect(connections).toEqual([]);
  });

  it('refuses n past the end of the voyage, and a voyage with no Driver turns', async () => {
    await saveVoyages();
    const { adapters, connections } = fakeAdapters();

    await expect(
      replayVoyage(['2', '4', '--runtime', 'kiro'], io, { adapters }),
    ).rejects.toThrow(
      'Voyage 2 of deck has 3 Driver turns; n must be from 1 to 3',
    );
    await expect(
      replayVoyage(['9', '--runtime', 'kiro'], io, { adapters }),
    ).rejects.toThrow(
      `No saved Driver turns for voyage 9 in any project in ${home}`,
    );
    expect(connections).toEqual([]);
  });

  it('reports a missing saved input without connecting', async () => {
    await saveVoyages();
    await save('deck', DRIVER, 8, 'after a gap');

    expect(await main(['replay', '3', '--runtime', 'kiro'], io)).toBe(1);
    expect(io.errors).toEqual([
      `Agent ${DRIVER} has no saved input for turn 7 (${turnFile(
        turnDir(projectTurnsDir('deck', home), DRIVER, 7),
        'input',
      )})`,
    ]);
  });

  it('is listed in the usage and prints its own help', async () => {
    expect(USAGE).toContain('replay <voyage> [n]');
    expect(await main(['replay', '--help'], io)).toBe(0);
    expect(io.lines).toEqual([REPLAY_USAGE]);
  });
});
