import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgeTerms, type BudgetWindow } from '@quarterdeck/rules';
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
import { createAgentLifecycle, gitWorktrees } from '../../src/agents/index.js';
import {
  startWake,
  type DriverNote,
  type Wake,
  type WakeLeg,
} from '../../src/crew/index.js';
import {
  assignTicket,
  blockTicket,
  recordPublished,
  storeDependencies,
  type BuilderContext,
  type TurnRecord,
} from '../../src/driver/index.js';
import { startPauseGate, type PauseGate } from '../../src/pause/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import { fakeBuilderSessions, git } from '../driver/builder-fixtures.js';
import {
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from '../driver/scripted-agent.js';

const TIMEOUT = 30_000;
const settle = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });
const NO_CAP: BudgetWindow = { hours: 5, capTokens: null, holdAtFraction: 0.8 };
const CAPPED: BudgetWindow = { hours: 5, capTokens: 1000, holdAtFraction: 0.8 };

describe('waking blocked work', () => {
  let library: Store;
  let retrofit: Store;
  let root: string;
  let scripted: ScriptedAgent;
  let pauseGate: PauseGate;
  let ctx: BuilderContext;
  let wake: Wake | undefined;
  let notes: DriverNote[];
  let watched: Promise<TurnRecord>[];
  let failures: unknown[];

  beforeAll(async () => {
    library = await openStore({ project: 'library', dataDir: IN_MEMORY });
    retrofit = await openStore({ project: 'retrofit', dataDir: IN_MEMORY });
  });

  afterAll(async () => {
    await library.close();
    await retrofit.close();
  });

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'qd-wake-')));
    const repo = join(root, 'repo');
    git(root, 'init', '--quiet', repo);
    git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'init');
    scripted = await startScriptedAgent();
    const sessions = fakeBuilderSessions(scripted.client);
    pauseGate = await startPauseGate({ store: retrofit, home: root });
    await library.db.query(
      'update projects set publishes = true where id = $1',
      [library.projectId],
    );
    ctx = {
      store: retrofit,
      lifecycle: createAgentLifecycle({
        naming: { theme: 'birds', names: ['crane'] },
        sessions,
        worktrees: gitWorktrees,
        openStores: () => [retrofit],
        budget: () => Promise.resolve(ctx.budget),
        random: () => 0,
      }),
      sessions,
      worktrees: gitWorktrees,
      runtime: 'claude',
      repoPath: repo,
      base: git(repo, 'rev-parse', 'HEAD'),
      terms: forgeTerms('github'),
      services: { forge: { forge: 'github', host: null }, tracker: null },
      worktreesDir: join(root, 'worktrees'),
      turnsDir: join(root, 'turns'),
      budget: NO_CAP,
      pause: pauseGate,
      dependencies: storeDependencies(() => [library, retrofit], {
        homeDir: root,
      }),
    };
    notes = [];
    watched = [];
    failures = [];
  });

  afterEach(async () => {
    wake?.close();
    await wake?.idle();
    await Promise.allSettled(watched);
    wake = undefined;
    await pauseGate.close();
    await scripted.client.close();
    await rm(root, { recursive: true, force: true });
    for (const store of [library, retrofit])
      await store.db.exec(
        `delete from events; delete from turns; delete from tickets;
         delete from agents;
         update projects set paused_at = null, publishes = null;`,
      );
  });

  const leg: WakeLeg = {
    project: 'retrofit',
    get store() {
      return retrofit;
    },
  };

  const begin = (): Wake => {
    wake = startWake({
      legs: () => [leg],
      dependencies: ctx.dependencies ?? storeDependencies(() => []),
      builders: () => Promise.resolve(ctx),
      note: (note) => notes.push(note),
      watch: (_leg, _builder, _ticket, turn) => watched.push(turn),
      report: (err) => failures.push(err),
    });
    return wake;
  };

  const insertTicket = async (
    store: Store,
    title: string,
    dependsOn: string[] = [],
  ): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title, depends_on)
       values ($1, $2, $3::uuid[]) returning id`,
      [store.projectId, title, dependsOn],
    );
    return rows[0]?.id ?? '';
  };

  const kinds = async (store: Store, kind: string) => {
    const { rows } = await store.db.query<{
      ticketId: string | null;
      payload: Record<string, unknown>;
    }>(
      `select ticket_id as "ticketId", payload from events
       where kind = $1 order by id`,
      [kind],
    );
    return rows;
  };

  const status = async (ticketId: string) => {
    const { rows } = await retrofit.db.query<{ status: string }>(
      'select status from tickets where id = $1',
      [ticketId],
    );
    return rows[0]?.status;
  };

  const blockedBuilder = async () => {
    const libraryTicket = await insertTicket(library, 'Add the call');
    const ticketId = await insertTicket(retrofit, 'Use the call');
    scripted.reply(say('Needs the library.'));
    const assignment = await assignTicket(ctx, { ticketId });
    await assignment.turn;
    await blockTicket(
      retrofit,
      ctx.dependencies ?? storeDependencies(() => []),
      {
        ticketId,
        on: [libraryTicket],
      },
    );
    return { libraryTicket, ticketId, builderId: assignment.builder.id };
  };

  const publishLibrary = async (ticketId: string) => {
    await library.db.query(`update tickets set status = 'done' where id = $1`, [
      ticketId,
    ]);
    await recordPublished(library, {
      ticketId,
      package: 'acme-library',
      version: '1.4.0',
    });
  };

  const pauseRetrofit = async (paused: boolean) => {
    await retrofit.db.query(
      `update projects set paused_at = case when $2::boolean then now() end
       where id = $1`,
      [retrofit.projectId, paused],
    );
    await retrofit.publish({ kind: 'pause.set' });
  };

  it(
    'holds a wake while the project is paused and sends it once on unpause',
    async () => {
      const { libraryTicket, ticketId } = await blockedBuilder();
      const running = begin();
      running.poke();
      await running.idle();
      expect(await status(ticketId)).toBe('blocked');

      await pauseRetrofit(true);
      await publishLibrary(libraryTicket);
      scripted.reply(say('Bumped.'));
      running.poke();
      await settle(async () => {
        expect(await kinds(retrofit, 'pause.held')).toHaveLength(1);
      });
      running.poke();
      expect(await status(ticketId)).toBe('blocked');
      expect(await kinds(retrofit, 'builder.continued')).toEqual([]);

      await pauseRetrofit(false);
      await settle(async () => {
        expect(await kinds(retrofit, 'builder.continued')).toHaveLength(1);
      });
      await running.idle();
      await Promise.all(watched);
      running.poke();
      await running.idle();

      expect(await status(ticketId)).toBe('assigned');
      expect(await kinds(retrofit, 'ticket.unblocked')).toHaveLength(1);
      expect(await kinds(retrofit, 'builder.continued')).toHaveLength(1);
      expect(watched).toHaveLength(1);
      expect(scripted.prompts.at(-1)?.text).toContain(
        'published acme-library 1.4.0',
      );
      expect(failures).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'leaves a held ticket blocked while the budget is held, then wakes it',
    async () => {
      const { libraryTicket, ticketId, builderId } = await blockedBuilder();
      await publishLibrary(libraryTicket);
      await retrofit.db.query(
        `insert into turns (agent_id, seq, prompt, input_tokens, ended_at)
         values ($1, 100, 'earlier work', 900, now())`,
        [builderId],
      );
      ctx = { ...ctx, budget: CAPPED };

      const running = begin();
      running.poke();
      await running.idle();
      expect(await status(ticketId)).toBe('blocked');
      expect(await kinds(retrofit, 'budget.held')).toHaveLength(1);
      expect(await kinds(retrofit, 'ticket.unblocked')).toEqual([]);

      ctx = { ...ctx, budget: NO_CAP };
      scripted.reply(say('Bumped.'));
      running.poke();
      await running.idle();
      expect(await status(ticketId)).toBe('assigned');
      expect(await kinds(retrofit, 'builder.continued')).toHaveLength(1);
      expect(failures).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'tells the Driver once when an unassigned ticket waits and once when it is ready',
    async () => {
      const libraryTicket = await insertTicket(library, 'Add the call');
      const waiting = await insertTicket(retrofit, 'Use the call', [
        libraryTicket,
      ]);
      const lost = await insertTicket(retrofit, 'Use a gone call', [
        '00000000-0000-4000-8000-000000000000',
      ]);
      const running = begin();
      running.poke();
      running.poke();
      await running.idle();
      running.poke();
      await running.idle();

      const marked = await kinds(retrofit, 'ticket.waiting');
      expect(marked).toHaveLength(2);
      expect(marked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ticketId: waiting }),
          {
            ticketId: lost,
            payload: expect.objectContaining({
              unmet: [
                expect.objectContaining({
                  project: null,
                  reason: 'it is in no open project',
                }),
              ],
            }),
          },
        ]),
      );

      await publishLibrary(libraryTicket);
      running.poke();
      await running.idle();
      running.poke();
      await running.idle();
      expect(await kinds(retrofit, 'ticket.unblocked')).toEqual([
        expect.objectContaining({
          ticketId: waiting,
          payload: expect.objectContaining({ held: false }),
        }),
      ]);
      expect(await status(waiting)).toBe('open');
      expect(notes).toEqual([]);
      expect(failures).toEqual([]);
    },
    TIMEOUT,
  );
});
