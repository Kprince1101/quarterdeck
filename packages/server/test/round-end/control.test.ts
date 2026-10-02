import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { loadRule } from '@quarterdeck/rules';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createAgentLifecycle,
  type AgentLifecycle,
} from '../../src/agents/index.js';
import { openDriverRound } from '../../src/driver/index.js';
import {
  NO_DRIVER_SESSION,
  ROUND_ENDED_EVENT,
  WRAP_UP_EVENTS,
  startRoundControl,
  type RoundControl,
  type RoundControlOptions,
  type RoundDriver,
} from '../../src/round-end/index.js';
import type { Store } from '../../src/store/index.js';
import { fakeWorktrees } from '../agents/fixtures.js';
import { startTestApi, type TestApi } from '../api/harness.js';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from '../driver/scripted-agent.js';
import {
  CLEAR_ROUND_TABLES,
  TIMEOUT,
  eventPayloads,
  insertAgent,
  insertCard,
  insertRound,
  insertTicket,
  lenientSessions,
} from './fixtures.js';

const project = 'control';
const BUS: McpServerStdio = {
  name: 'quarterdeck',
  command: 'node',
  args: ['relay.js'],
  env: [],
};
const BIRTH = { summary: 'Nothing to assign.', actions: [] };
const WRAP_UP = {
  summary: 'Ended by hand.',
  notebook: [{ op: 'add', body: 'End early when blocked.' }],
  charter: null,
};

interface IntentRow {
  status: string;
  result: Record<string, unknown> | null;
}

describe('End and Kill from the dashboard', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let store: Store;
  let scripted: ScriptedAgent;
  let repoDir = '';
  let turnsDir = '';
  let control: RoundControl | undefined;
  let steps: string[] = [];

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'qd-repo-'));
    turnsDir = await mkdtemp(join(tmpdir(), 'qd-turns-'));
    t = await startTestApi();
    await t.send('project.create', { project, repoPath: repoDir });
    store = await t.store(project);
    scripted = await startScriptedAgent();
  }, TIMEOUT);

  afterEach(async () => {
    await control?.close();
    control = undefined;
    steps = [];
    await store.db.exec(`${CLEAR_ROUND_TABLES} delete from intents;`);
  });

  afterAll(async () => {
    await scripted.client.close();
    await t.close();
    await rm(repoDir, { recursive: true, force: true });
    await rm(turnsDir, { recursive: true, force: true });
  });

  const lifecycle = (): Pick<AgentLifecycle, 'retire'> => {
    const real = createAgentLifecycle({
      naming: { theme: 'birds', names: ['lark'] },
      sessions: lenientSessions(),
      worktrees: fakeWorktrees(),
      openStores: () => [store],
      budget: () =>
        Promise.resolve({ hours: 5, capTokens: null, holdAtFraction: 0.8 }),
    });
    return {
      retire: async (on, agentId, options) => {
        steps.push(`retire ${agentId}`);
        return real.retire(on, agentId, options);
      },
    };
  };

  const start = async (
    driver?: (roundId: string) => RoundDriver | undefined,
  ): Promise<RoundControl> => {
    const options: RoundControlOptions = {
      store,
      lifecycle: lifecycle(),
      onError: () => undefined,
    };
    if (driver !== undefined) options.driver = driver;
    control = await startRoundControl(options);
    return control;
  };

  const send = async (intent: 'round.end' | 'round.kill', roundId: string) => {
    const reply = await t.send(intent, { project, roundId });
    expect(reply.status).toBe(202);
    return String(reply.body.id);
  };

  const intent = async (id: string): Promise<IntentRow | undefined> => {
    const { rows } = await store.db.query<IntentRow>(
      'select status, result from intents where id = $1',
      [id],
    );
    return rows[0];
  };

  const statusOf = async (
    table: 'agents' | 'tickets' | 'cards',
    id: string,
  ) => {
    const { rows } = await store.db.query<{ status: string }>(
      `select status from ${table} where id = $1`,
      [id],
    );
    return rows[0]?.status;
  };

  const openRound = async (number: number) => {
    const roundId = await insertRound(store, number);
    const agentId = await insertAgent(store, {
      name: 'lark',
      role: 'driver',
      roundId,
    });
    scripted.reply(say(resultText(BIRTH)));
    const round = await openDriverRound({
      store,
      client: scripted.client,
      bus: { launch: async () => BUS },
      agentId,
      roundId,
      cwd: repoDir,
      charter: await loadRule('charter', { homeDir: t.homeDir, repoDir }),
      turnsDir,
      budget: { hours: 5, capTokens: null, holdAtFraction: 0.8 },
    });
    await round.birth;
    const driver: RoundDriver = {
      round: {
        agent: round.agent,
        round: round.round,
        turnAs: (input, format) => {
          steps.push('wrap-up');
          return round.turnAs(input, format);
        },
      },
      charter: 'Ship small.',
    };
    return { roundId, driverId: agentId, driver };
  };

  it('End closes cards, retires builders, then wraps up, then retires the Driver', async () => {
    const { roundId, driverId, driver } = await openRound(1);
    const builder = await insertAgent(store, { name: 'pike', roundId });
    const reviewer = await insertAgent(store, {
      name: 'thimble',
      role: 'reviewer',
    });
    const ask = await insertCard(store, { agentId: builder });
    const ticket = await insertTicket(store, 'in_review', builder);
    const id = await send('round.end', roundId);
    scripted.reply(say(resultText(WRAP_UP)));

    const drivers = new Map([[roundId, driver]]);
    await (await start((asked) => drivers.get(asked))).drain();

    expect(steps).toEqual([
      `retire ${builder}`,
      'wrap-up',
      `retire ${driverId}`,
    ]);
    const row = await intent(id);
    expect(row).toMatchObject({
      status: 'applied',
      result: {
        roundId,
        round: 1,
        ended: true,
        closedCards: [ask],
        retired: [builder, driverId],
        discardCards: [],
        reopened: [],
        wrapUp: { status: 'proposed', summary: 'Ended by hand.' },
      },
    });
    expect(await statusOf('cards', ask)).toBe('expired');
    expect(await statusOf('agents', reviewer)).toBe('idle');
    expect(await statusOf('tickets', ticket)).toBe('in_review');
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toEqual([
      expect.objectContaining({ roundId, reason: 'ended' }),
    ]);
    expect(await eventPayloads(store, WRAP_UP_EVENTS.proposed)).toHaveLength(1);
  });

  it('End with no live Driver session records a missed wrap-up and still ends the round', async () => {
    const roundId = await insertRound(store, 2);
    const driverId = await insertAgent(store, {
      name: 'lark',
      role: 'driver',
      roundId,
    });
    const id = await send('round.end', roundId);

    await (await start()).drain();

    expect(await intent(id)).toMatchObject({
      status: 'applied',
      result: {
        ended: true,
        retired: [driverId],
        wrapUp: { status: 'missed', reason: NO_DRIVER_SESSION },
      },
    });
    expect(await eventPayloads(store, WRAP_UP_EVENTS.missed)).toEqual([
      { roundId, round: 2, reason: NO_DRIVER_SESSION },
    ]);
  });

  it('Kill skips the wrap-up and reopens only the tickets this round assigned', async () => {
    const { roundId, driverId, driver } = await openRound(3);
    const builder = await insertAgent(store, { name: 'pike', roundId });
    const earlier = await insertRound(store, 2, 'ended');
    const outsider = await insertAgent(store, {
      name: 'okapi',
      roundId: earlier,
    });
    const mine = await insertTicket(store, 'in_progress', builder);
    const theirs = await insertTicket(store, 'in_progress', outsider);
    const id = await send('round.kill', roundId);

    await (await start(() => driver)).drain();

    expect(steps).toEqual([`retire ${builder}`, `retire ${driverId}`]);
    expect(await intent(id)).toMatchObject({
      status: 'applied',
      result: { ended: true, reopened: [mine], retired: [builder, driverId] },
    });
    expect(await statusOf('tickets', mine)).toBe('open');
    expect(await statusOf('tickets', theirs)).toBe('in_progress');
    expect(await eventPayloads(store, WRAP_UP_EVENTS.proposed)).toEqual([]);
    expect(await eventPayloads(store, WRAP_UP_EVENTS.missed)).toEqual([]);
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toEqual([
      expect.objectContaining({ reason: 'killed', reopened: [mine] }),
    ]);
  });

  it('rejects an End queued behind a Kill of the same round', async () => {
    const roundId = await insertRound(store, 4);
    const kill = await send('round.kill', roundId);
    const end = await send('round.end', roundId);

    await (await start()).drain();

    expect(await intent(kill)).toMatchObject({ status: 'applied' });
    expect(await intent(end)).toEqual({
      status: 'rejected',
      result: { error: `round ${roundId} has already ended` },
    });
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toHaveLength(1);
  });

  it('applies an intent sent while it is running', async () => {
    const roundId = await insertRound(store, 5);
    const running = await start();
    const id = await send('round.kill', roundId);

    await expect
      .poll(async () => (await intent(id))?.status, { timeout: 5_000 })
      .toBe('applied');
    await running.drain();
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toHaveLength(1);
  });
});
