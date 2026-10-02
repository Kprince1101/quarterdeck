import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Naming } from '@quarterdeck/rules';
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
  WorktreeDirtyError,
  createAgentLifecycle,
  gitWorktrees,
  type AgentLifecycle,
} from '../../src/agents/index.js';
import {
  AgentNotRetiredError,
  BuilderNotAvailableError,
  BuilderSessionLostError,
  DRIVER_TURN_INSTRUCTIONS,
  TICKET_ASSIGNED_EVENT,
  TicketNotAssignableError,
  applyBuilderAction,
  assignTicket,
  builderActionSchema,
  builderWorktreePath,
  continueBuilder,
  reassignTickets,
  type BuilderContext,
} from '../../src/driver/index.js';
import {
  PauseDroppedError,
  startPauseGate,
  type PauseGate,
} from '../../src/pause/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  fakeBuilderSessions,
  git,
  type FakeBuilderSessions,
} from './builder-fixtures.js';
import {
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from './scripted-agent.js';

const TIMEOUT = 30_000;
const settle = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });
const BIRDS: Naming = { theme: 'birds', names: ['crane', 'heron', 'ibis'] };

interface TicketSeed {
  title?: string;
  body?: string;
  status?: string;
  assigneeId?: string | null;
  dependsOn?: string[];
  prUrl?: string | null;
  headSha?: string | null;
}

interface TicketRow {
  status: string;
  assigneeId: string | null;
}

interface AgentRow {
  name: string;
  status: string;
  sessionId: string | null;
  worktreePath: string | null;
}

describe('builder assignment and continue', () => {
  let store: Store;
  let scripted: ScriptedAgent;
  let sessions: FakeBuilderSessions;
  let lifecycle: AgentLifecycle;
  let root: string;
  let repo: string;
  let base: string;
  let ctx: BuilderContext;
  let pauseGate: PauseGate;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'qd-assign-')));
    repo = join(root, 'repo');
    git(root, 'init', '--quiet', repo);
    git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'init');
    base = git(repo, 'rev-parse', 'HEAD');
    scripted = await startScriptedAgent();
    sessions = fakeBuilderSessions(scripted.client);
    pauseGate = await startPauseGate({ store, home: root });
    lifecycle = createAgentLifecycle({
      naming: BIRDS,
      sessions,
      worktrees: gitWorktrees,
      openStores: () => [store],
      random: () => 0,
    });
    ctx = {
      store,
      lifecycle,
      sessions,
      worktrees: gitWorktrees,
      runtime: 'claude',
      repoPath: repo,
      base,
      worktreesDir: join(root, 'worktrees'),
      turnsDir: join(root, 'turns'),
      pause: pauseGate,
    };
  });

  afterEach(async () => {
    await pauseGate.close();
    await scripted.client.close();
    await rm(root, { recursive: true, force: true });
    await store.db.exec(
      `delete from events; delete from turns; delete from cards;
       delete from tickets; delete from agents;
       update projects set paused_at = null;`,
    );
  });

  const pauseProject = async (paused: boolean) => {
    await store.db.query(
      `update projects set paused_at = case when $2::boolean then now() end
       where id = $1`,
      [store.projectId, paused],
    );
    await store.publish({ kind: 'pause.set' });
  };

  const setAgentStatus = async (agentId: string, status: string) => {
    await store.db.query('update agents set status = $2 where id = $1', [
      agentId,
      status,
    ]);
  };

  const insertTicket = async (seed: TicketSeed = {}): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into tickets
         (project_id, title, body, status, assignee_id, depends_on, pr_url, head_sha)
       values ($1, $2, $3, $4, $5, $6::uuid[], $7, $8) returning id`,
      [
        store.projectId,
        seed.title ?? 'QD9 widget',
        seed.body ?? 'Build the widget.',
        seed.status ?? 'open',
        seed.assigneeId ?? null,
        seed.dependsOn ?? [],
        seed.prUrl ?? null,
        seed.headSha ?? null,
      ],
    );
    return rows[0]?.id ?? '';
  };

  const ticketRow = async (
    ticketId: string,
  ): Promise<TicketRow | undefined> => {
    const { rows } = await store.db.query<TicketRow>(
      `select status, assignee_id as "assigneeId" from tickets where id = $1`,
      [ticketId],
    );
    return rows[0];
  };

  const agentRow = async (agentId: string): Promise<AgentRow | undefined> => {
    const { rows } = await store.db.query<AgentRow>(
      `select name, status, session_id as "sessionId",
              worktree_path as "worktreePath"
       from agents where id = $1`,
      [agentId],
    );
    return rows[0];
  };

  const agentCount = async (): Promise<number> => {
    const { rows } = await store.db.query<{ count: number }>(
      'select count(*)::int as count from agents',
    );
    return rows[0]?.count ?? -1;
  };

  const events = async (kind: string) => {
    const { rows } = await store.db.query<{
      agentId: string | null;
      ticketId: string | null;
      payload: Record<string, unknown>;
    }>(
      `select agent_id as "agentId", ticket_id as "ticketId", payload
       from events where kind = $1 order by id`,
      [kind],
    );
    return rows;
  };

  const turnTickets = async (agentId: string) => {
    const { rows } = await store.db.query<{ ticketId: string | null }>(
      `select ticket_id as "ticketId" from turns
       where agent_id = $1 order by seq`,
      [agentId],
    );
    return rows.map((row) => row.ticketId);
  };

  const isDetachedAt = (path: string, commit: string): boolean =>
    git(path, 'rev-parse', 'HEAD') === commit &&
    git(path, 'branch', '--show-current') === '';

  const assignAndSettle = async (ticketId: string, builderId?: string) => {
    scripted.reply(say('On it.'));
    const request: { ticketId: string; builderId?: string } = { ticketId };
    if (builderId !== undefined) request.builderId = builderId;
    const assignment = await assignTicket(ctx, request);
    await assignment.turn;
    return assignment;
  };

  it(
    'gives an approved ticket to a new builder in its own worktree',
    async () => {
      const ticketId = await insertTicket();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      scripted.reply(say('On it.', { gate }));

      const assignment = await assignTicket(ctx, { ticketId });

      const path = join(root, 'worktrees', `crane-${ticketId.slice(0, 8)}`);
      expect(assignment).toMatchObject({
        born: true,
        worktreePath: path,
        previousAssigneeId: null,
        builder: { name: 'crane', role: 'builder', runtime: 'claude' },
        ticket: { id: ticketId, status: 'assigned' },
      });
      expect(builderWorktreePath(ctx.worktreesDir, 'crane', ticketId)).toBe(
        path,
      );
      expect(isDetachedAt(path, base)).toBe(true);
      expect(sessions.opened).toEqual([
        { agent: 'crane', sessionId: expect.any(String), cwd: path },
      ]);
      expect(await ticketRow(ticketId)).toEqual({
        status: 'assigned',
        assigneeId: assignment.builder.id,
      });
      expect(await agentRow(assignment.builder.id)).toMatchObject({
        status: 'working',
        worktreePath: path,
      });

      release();
      const turn = await assignment.turn;

      expect(turn.text).toBe('On it.');
      const [prompt] = scripted.prompts;
      expect(prompt?.sessionId).toBe(assignment.builder.sessionId);
      expect(prompt?.text).toContain(`# Ticket ${ticketId}: QD9 widget`);
      expect(prompt?.text).toContain('Build the widget.');
      expect(prompt?.text).toContain(`Work in ${path}`);
      expect(prompt?.text).toContain('`report`');
      expect(await turnTickets(assignment.builder.id)).toEqual([ticketId]);
      expect((await agentRow(assignment.builder.id))?.status).toBe('idle');
      expect(await events(TICKET_ASSIGNED_EVENT)).toEqual([
        {
          agentId: assignment.builder.id,
          ticketId,
          payload: {
            name: 'crane',
            worktreePath: path,
            born: true,
            previousAssigneeId: null,
          },
        },
      ]);
    },
    TIMEOUT,
  );

  it('refuses a ticket that is not approved, taken or waiting on another', async () => {
    const blocker = await insertTicket({ status: 'in_progress' });
    const waiting = await insertTicket({ dependsOn: [blocker] });
    const proposed = await insertTicket({ status: 'cancelled' });

    await expect(assignTicket(ctx, { ticketId: waiting })).rejects.toThrow(
      `it waits on ${blocker}`,
    );
    await expect(
      assignTicket(ctx, { ticketId: proposed }),
    ).rejects.toBeInstanceOf(TicketNotAssignableError);
    await expect(
      assignTicket(ctx, { ticketId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow('it is not in this project');
    expect(await agentCount()).toBe(0);
    expect(sessions.opened).toEqual([]);
  });

  it(
    'assigns a ticket once everything it depends on is done',
    async () => {
      const done = await insertTicket({ status: 'done' });
      const ticketId = await insertTicket({ dependsOn: [done] });

      const assignment = await assignAndSettle(ticketId);

      expect(assignment.ticket.status).toBe('assigned');
    },
    TIMEOUT,
  );

  it(
    'moves an idle builder to a new worktree and session for its next ticket',
    async () => {
      const first = await insertTicket({ title: 'QD1' });
      const second = await insertTicket({ title: 'QD2' });
      const before = await assignAndSettle(first);
      await store.db.query(`update tickets set status = 'done' where id = $1`, [
        first,
      ]);

      const after = await assignAndSettle(second, before.builder.id);

      expect(after.born).toBe(false);
      expect(after.builder.id).toBe(before.builder.id);
      expect(existsSync(before.worktreePath)).toBe(false);
      expect(isDetachedAt(after.worktreePath, base)).toBe(true);
      expect(after.worktreePath).toBe(
        builderWorktreePath(ctx.worktreesDir, 'crane', second),
      );
      expect(sessions.closed).toEqual([before.builder.sessionId]);
      expect(sessions.opened.map((session) => session.cwd)).toEqual([
        before.worktreePath,
        after.worktreePath,
      ]);
      expect(after.builder.sessionId).toBe(sessions.opened[1]?.sessionId);
      expect(scripted.prompts[1]?.sessionId).toBe(after.builder.sessionId);
      expect(await agentRow(after.builder.id)).toMatchObject({
        status: 'idle',
        sessionId: after.builder.sessionId,
        worktreePath: after.worktreePath,
      });
    },
    TIMEOUT,
  );

  it(
    'refuses a builder that holds a ticket, is busy or is not a builder',
    async () => {
      const held = await insertTicket();
      const next = await insertTicket();
      const { builder } = await assignAndSettle(held);
      const { rows } = await store.db.query<{ id: string }>(
        `insert into agents (project_id, name, role, status)
         values ($1, 'thimble', 'reviewer', 'idle') returning id`,
        [store.projectId],
      );
      const reviewer = rows[0]?.id ?? '';

      await expect(
        assignTicket(ctx, { ticketId: next, builderId: builder.id }),
      ).rejects.toThrow(`it holds ticket ${held}`);
      await expect(
        assignTicket(ctx, { ticketId: next, builderId: reviewer }),
      ).rejects.toThrow('its role is reviewer');
      await store.db.query(`update agents set status = 'stuck' where id = $1`, [
        builder.id,
      ]);
      await store.db.query(`update tickets set status = 'done' where id = $1`, [
        held,
      ]);
      await expect(
        assignTicket(ctx, { ticketId: next, builderId: builder.id }),
      ).rejects.toBeInstanceOf(BuilderNotAvailableError);
      expect(await ticketRow(next)).toEqual({
        status: 'open',
        assigneeId: null,
      });
    },
    TIMEOUT,
  );

  it(
    'keeps a builder and its unsaved work when its old worktree is dirty',
    async () => {
      const first = await insertTicket();
      const second = await insertTicket();
      const { builder, worktreePath } = await assignAndSettle(first);
      await store.db.query(`update tickets set status = 'done' where id = $1`, [
        first,
      ]);
      writeFileSync(join(worktreePath, 'wip.txt'), 'unsaved');

      await expect(
        assignTicket(ctx, { ticketId: second, builderId: builder.id }),
      ).rejects.toBeInstanceOf(WorktreeDirtyError);

      expect(existsSync(join(worktreePath, 'wip.txt'))).toBe(true);
      expect(await agentRow(builder.id)).toMatchObject({
        status: 'idle',
        worktreePath,
      });
      expect(await ticketRow(second)).toEqual({
        status: 'open',
        assigneeId: null,
      });
    },
    TIMEOUT,
  );

  it(
    'retires an unborn builder and removes its worktree when its session fails',
    async () => {
      const ticketId = await insertTicket();
      sessions.failNext('runtime not signed in');

      await expect(assignTicket(ctx, { ticketId })).rejects.toThrow(
        'runtime not signed in',
      );

      const path = builderWorktreePath(ctx.worktreesDir, 'crane', ticketId);
      expect(existsSync(path)).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(path);
      expect(await events('agent.birth_failed')).toHaveLength(1);
      expect(await ticketRow(ticketId)).toEqual({
        status: 'open',
        assigneeId: null,
      });
    },
    TIMEOUT,
  );

  it(
    'retires an unborn builder when its worktree cannot be added',
    async () => {
      const ticketId = await insertTicket();
      ctx = { ...ctx, base: 'no-such-ref' };

      await expect(assignTicket(ctx, { ticketId })).rejects.toThrow();

      expect(sessions.opened).toEqual([]);
      expect(await events('agent.birth_failed')).toHaveLength(1);
      expect(await ticketRow(ticketId)).toEqual({
        status: 'open',
        assigneeId: null,
      });
    },
    TIMEOUT,
  );

  it(
    'continues an idle builder in its session, filed under its ticket',
    async () => {
      const ticketId = await insertTicket();
      const { builder } = await assignAndSettle(ticketId);
      scripted.reply(say('Fixed the lint.'));

      const continuation = await continueBuilder(ctx, {
        builderId: builder.id,
        prompt: '  CI failed on lint; fix it and push.  ',
      });
      const turn = await continuation.turn;

      expect(continuation.ticketId).toBe(ticketId);
      expect(turn.text).toBe('Fixed the lint.');
      expect(scripted.prompts[1]).toEqual({
        sessionId: builder.sessionId,
        text: 'CI failed on lint; fix it and push.',
      });
      expect(scripted.sessions).toHaveLength(1);
      expect(await turnTickets(builder.id)).toEqual([ticketId, ticketId]);
      expect(await events('builder.continued')).toEqual([
        {
          agentId: builder.id,
          ticketId,
          payload: {
            name: 'crane',
            prompt: 'CI failed on lint; fix it and push.',
          },
        },
      ]);
      expect((await agentRow(builder.id))?.status).toBe('idle');
    },
    TIMEOUT,
  );

  it(
    'refuses to continue a working builder, an empty prompt or a lost session',
    async () => {
      const ticketId = await insertTicket();
      const { builder } = await assignAndSettle(ticketId);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      scripted.reply(say('Working.', { gate }));
      const running = await continueBuilder(ctx, {
        builderId: builder.id,
        prompt: 'Rebase on main.',
      });

      await expect(
        continueBuilder(ctx, { builderId: builder.id, prompt: 'Again.' }),
      ).rejects.toThrow('it is working');
      release();
      await running.turn;
      await expect(
        continueBuilder(ctx, { builderId: builder.id, prompt: '   ' }),
      ).rejects.toThrow('cannot be empty');

      sessions.lose(builder.sessionId ?? '');
      await expect(
        continueBuilder(ctx, { builderId: builder.id, prompt: 'Hello?' }),
      ).rejects.toBeInstanceOf(BuilderSessionLostError);
      expect((await agentRow(builder.id))?.status).toBe('idle');
      expect(scripted.prompts).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    'holds an assignment while the project is paused and launches it on unpause',
    async () => {
      const ticketId = await insertTicket();
      await pauseProject(true);
      scripted.reply(say('On it.'));

      const assigning = assignTicket(ctx, { ticketId });
      await settle(async () => {
        expect(await events('pause.held')).toHaveLength(1);
      });

      expect(await events('pause.held')).toEqual([
        {
          agentId: null,
          ticketId,
          payload: {
            operation: 'launch',
            label: 'assign: QD9 widget',
            scopes: ['project'],
          },
        },
      ]);
      expect(await agentCount()).toBe(0);
      expect(sessions.opened).toEqual([]);
      expect(await ticketRow(ticketId)).toEqual({
        status: 'open',
        assigneeId: null,
      });

      await pauseProject(false);
      const assignment = await assigning;
      await assignment.turn;

      expect(assignment).toMatchObject({
        born: true,
        ticket: { id: ticketId },
      });
      expect(await events('pause.replayed')).toEqual([
        {
          agentId: null,
          ticketId,
          payload: {
            operation: 'launch',
            label: 'assign: QD9 widget',
            heldEventId: expect.any(Number),
          },
        },
      ]);
      expect(scripted.prompts).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'holds a continue while its builder is paused and sends it on resume',
    async () => {
      const ticketId = await insertTicket();
      const { builder } = await assignAndSettle(ticketId);
      await setAgentStatus(builder.id, 'paused');
      scripted.reply(say('Rebased.'));

      const continuing = continueBuilder(ctx, {
        builderId: builder.id,
        prompt: 'Rebase on main.\nThen push.',
      });
      await settle(async () => {
        expect(await events('pause.held')).toHaveLength(1);
      });

      expect(await events('pause.held')).toEqual([
        {
          agentId: builder.id,
          ticketId: null,
          payload: {
            operation: 'continue',
            label: 'continue: Rebase on main.',
            scopes: ['agent'],
          },
        },
      ]);
      await pauseGate.replay();
      expect(pauseGate.held()).toHaveLength(1);
      expect(scripted.prompts).toHaveLength(1);

      await setAgentStatus(builder.id, 'idle');
      await store.publish({ kind: 'agent.resume', agentId: builder.id });
      const continuation = await continuing;

      expect((await continuation.turn).text).toBe('Rebased.');
      expect(scripted.prompts[1]?.text).toBe('Rebase on main.\nThen push.');
      expect(await events('pause.replayed')).toHaveLength(1);
      expect(pauseGate.held()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'leaves a ticket unassigned when its held assignment is dropped',
    async () => {
      const ticketId = await insertTicket();
      await pauseProject(true);

      const assigning = assignTicket(ctx, { ticketId });
      await settle(async () => {
        expect(pauseGate.held()).toHaveLength(1);
      });
      await pauseGate.close();

      await expect(assigning).rejects.toBeInstanceOf(PauseDroppedError);
      expect(await events('pause.dropped')).toEqual([
        {
          agentId: null,
          ticketId,
          payload: {
            operation: 'launch',
            label: 'assign: QD9 widget',
            heldEventId: expect.any(Number),
            reason: 'closed',
          },
        },
      ]);
      expect(await agentCount()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    're-assigns a retired builder’s tickets to a new builder',
    async () => {
      const ticketId = await insertTicket();
      const first = await assignAndSettle(ticketId);
      await store.db.query(
        `update tickets set status = 'in_review', pr_url = $2, head_sha = $3
         where id = $1`,
        [ticketId, 'https://github.com/acme/deck/pull/7', 'a'.repeat(40)],
      );

      await expect(
        reassignTickets(ctx, first.builder.id),
      ).rejects.toBeInstanceOf(AgentNotRetiredError);
      await lifecycle.retire(store, first.builder.id);
      scripted.reply(say('Picking it up.'));
      const [next, ...rest] = await reassignTickets(ctx, first.builder.id);
      await next?.turn;

      expect(rest).toEqual([]);
      expect(next).toMatchObject({
        born: true,
        previousAssigneeId: first.builder.id,
        ticket: { id: ticketId, status: 'in_review' },
      });
      expect(next?.builder.id).not.toBe(first.builder.id);
      expect(sessions.opened.map((session) => session.cwd)).toEqual([
        first.worktreePath,
        next?.worktreePath,
      ]);
      expect(next?.worktreePath).toBe(
        builderWorktreePath(
          ctx.worktreesDir,
          next?.builder.name ?? '',
          ticketId,
        ),
      );
      expect(isDetachedAt(next?.worktreePath ?? '', base)).toBe(true);
      expect(await ticketRow(ticketId)).toEqual({
        status: 'in_review',
        assigneeId: next?.builder.id,
      });
      expect(scripted.prompts[1]?.text).toContain(
        'https://github.com/acme/deck/pull/7',
      );
      expect(
        (await events(TICKET_ASSIGNED_EVENT)).map(
          (event) => event.payload['previousAssigneeId'],
        ),
      ).toEqual([null, first.builder.id]);
      expect(await reassignTickets(ctx, first.builder.id)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'applies assign and continue actions from a Driver turn result',
    async () => {
      const ticketId = await insertTicket();
      expect(DRIVER_TURN_INSTRUCTIONS).toContain('"kind": "assign"');
      expect(DRIVER_TURN_INSTRUCTIONS).toContain('"kind": "continue"');
      expect(
        builderActionSchema.safeParse({ kind: 'continue', builder: 'crane' })
          .success,
      ).toBe(false);

      scripted.reply(say('On it.'), say('Pushed.'));
      const assigned = await applyBuilderAction(
        ctx,
        builderActionSchema.parse({ kind: 'assign', ticket: ticketId }),
      );
      if (assigned.kind !== 'assign') throw new Error('expected an assign');
      await assigned.assignment.turn;
      const continued = await applyBuilderAction(
        ctx,
        builderActionSchema.parse({
          kind: 'continue',
          builder: assigned.assignment.builder.id,
          prompt: 'Push your branch.',
        }),
      );
      if (continued.kind !== 'continue') throw new Error('expected a continue');
      await continued.continuation.turn;

      expect(scripted.prompts.map((prompt) => prompt.text)[1]).toBe(
        'Push your branch.',
      );
    },
    TIMEOUT,
  );
});
