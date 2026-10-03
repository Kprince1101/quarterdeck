import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREW_FAILED_EVENT } from '../../src/crew/index.js';
import {
  startQuarterdeck,
  type Quarterdeck,
} from '../../src/quarterdeck/index.js';
import {
  projectWorktreesDir,
  quarterdeckHome,
  type Store,
} from '../../src/store/index.js';
import { git } from '../driver/builder-fixtures.ts';
import {
  TIMEOUT,
  WAIT,
  createRepo,
  crewRuntime,
  eventsOf,
  fakeGitHub,
  proposeTicket,
  sendIntent,
  storeOf,
  valueOf,
  writeMachineRule,
} from './crew-fixtures.ts';

const PROJECTS = ['example', 'sample'] as const;

interface AgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  worktreePath: string | null;
}

const agentsOf = async (store: Store, role: string): Promise<AgentRow[]> => {
  const { rows } = await store.db.query<AgentRow>(
    `select id, name, role, status, worktree_path as "worktreePath"
     from agents where project_id = $1 and role = $2 order by created_at`,
    [store.projectId, role],
  );
  return rows;
};

const forgeOf = (onGitlab: boolean): 'github' | 'gitlab' => {
  if (onGitlab) return 'gitlab';
  return 'github';
};

const promptsOf = async (store: Store, role: string): Promise<string[]> => {
  const { rows } = await store.db.query<{ prompt: string }>(
    `select t.prompt from turns t join agents a on a.id = t.agent_id
     where a.project_id = $1 and a.role = $2 order by t.id`,
    [store.projectId, role],
  );
  return rows.map(({ prompt }) => prompt);
};

const voyageStatus = (store: Store): Promise<string | undefined> =>
  valueOf<string>(
    store,
    'select status as value from voyages where project_id = $1 and number = 1',
    [store.projectId],
  );

describe('one voyage across every project', { timeout: TIMEOUT }, () => {
  let homeDir = '';
  const cleanup: (() => Promise<void>)[] = [];
  const repos = new Map<string, string>();

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-voyage-'));
    await writeMachineRule(homeDir, 'lifecycle.json', {
      autoEndSettleSeconds: 1,
      mergeGate: { autoMerge: false },
    });
  });

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    await rm(homeDir, { recursive: true, force: true });
    repos.clear();
  });

  const start = async (
    onGitlab = false,
  ): Promise<{
    qd: Quarterdeck;
    launches: ReturnType<typeof crewRuntime>['launches'];
  }> => {
    const runtime = crewRuntime(
      Object.fromEntries(PROJECTS.map((project) => [project, { onGitlab }])),
    );
    const qd = await startQuarterdeck({
      port: 0,
      homeDir,
      adapters: runtime.adapters,
      forge: fakeGitHub(forgeOf(onGitlab)),
    });
    cleanup.push(() => qd.close());
    for (const project of PROJECTS) {
      const repo = await createRepo();
      repos.set(project, repo);
      cleanup.push(() => rm(repo, { recursive: true, force: true }));
      const created = await sendIntent(qd, 'project.create', {
        project,
        repoPath: repo,
      });
      expect(created.status).toBe(200);
    }
    return { qd, launches: runtime.launches };
  };

  it('has one Driver assign in each project, one reviewer review both, and a per-project Kill stop only that project', async () => {
    const { qd, launches } = await start();
    const stores = PROJECTS.map((project) => storeOf(qd, project));

    const started = await sendIntent(qd, 'voyage.start', { goal: 'Ship both' });
    expect(started).toEqual({
      status: 200,
      body: expect.objectContaining({
        result: { voyage: 1, goal: 'Ship both', projects: [...PROJECTS] },
      }),
    });
    for (const store of stores) {
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'driver.voyage_started')).toHaveLength(1);
      }, WAIT);
    }
    const drivers = await Promise.all(
      stores.map((store) => agentsOf(store, 'driver')),
    );
    const driverNames = new Set(drivers.flat().map(({ name }) => name));
    expect(driverNames.size).toBe(1);
    const [driverName] = driverNames;
    expect(
      launches.filter((launch) => launch.agentName === driverName),
    ).toHaveLength(1);
    expect(
      launches.find((launch) => launch.agentName === driverName)?.cwd,
    ).not.toContain(repos.get('example') ?? '');

    const tickets = await Promise.all(
      stores.map((store) => proposeTicket(store, 'Add a greeting')),
    );
    for (const [index, project] of PROJECTS.entries()) {
      const approved = await sendIntent(qd, 'ticket.approve', {
        project,
        ticketId: tickets[index],
      });
      expect(approved.status).toBe(200);
    }

    const home = quarterdeckHome(homeDir);
    for (const [index, project] of PROJECTS.entries()) {
      const store = stores[index] as Store;
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'ticket.assigned')).toEqual([
          expect.objectContaining({ ticketId: tickets[index] }),
        ]);
      }, WAIT);
      const [builder] = await agentsOf(store, 'builder');
      const worktree = builder?.worktreePath ?? '';
      expect(worktree.startsWith(projectWorktreesDir(project, home))).toBe(
        true,
      );
      expect(git(repos.get(project) ?? '', 'worktree', 'list')).toContain(
        worktree,
      );
    }

    for (const [index, store] of stores.entries()) {
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'ticket.verdict')).toEqual([
          expect.objectContaining({
            ticketId: tickets[index],
            payload: expect.objectContaining({ decision: 'approve' }),
          }),
        ]);
      }, WAIT);
    }
    const reviewers = await Promise.all(
      stores.map((store) => agentsOf(store, 'reviewer')),
    );
    const reviewerNames = new Set(reviewers.flat().map(({ name }) => name));
    expect(reviewerNames.size).toBe(1);
    const [reviewerName] = reviewerNames;
    expect(
      launches.filter((launch) => launch.agentName === reviewerName),
    ).toHaveLength(1);

    const [example, sample] = stores as [Store, Store];
    const killed = await sendIntent(qd, 'project.kill', { project: 'example' });
    expect(killed.status).toBe(202);
    await vi.waitFor(async () => {
      expect((await agentsOf(example, 'builder'))[0]?.status).toBe('killed');
    }, WAIT);
    expect((await agentsOf(sample, 'builder'))[0]?.status).not.toBe('killed');
    expect((await agentsOf(example, 'driver'))[0]?.status).not.toBe('killed');
    expect(await voyageStatus(example)).toBe('active');
    expect(await voyageStatus(sample)).toBe('active');

    const all = await sendIntent(qd, 'voyage.kill', { voyage: 1 });
    expect(all.status).toBe(200);
    expect(await voyageStatus(example)).toBe('ended');
    expect(await voyageStatus(sample)).toBe('ended');
    for (const store of stores)
      expect(await eventsOf(store, CREW_FAILED_EVENT)).toEqual([]);
  });

  it('words an all-GitLab voyage in merge-request terms for the Driver and the reviewer', async () => {
    const { qd } = await start(true);
    const [example, sample] = PROJECTS.map((project) =>
      storeOf(qd, project),
    ) as [Store, Store];
    await sendIntent(qd, 'voyage.start', { goal: 'Ship both' });
    await vi.waitFor(async () => {
      expect(await eventsOf(example, 'driver.voyage_started')).toHaveLength(1);
    }, WAIT);
    const ticketId = await proposeTicket(sample, 'Add a greeting');
    await sendIntent(qd, 'ticket.approve', { project: 'sample', ticketId });
    await vi.waitFor(async () => {
      expect(await eventsOf(sample, 'ticket.verdict')).toHaveLength(1);
    }, WAIT);

    const [birth] = await promptsOf(example, 'driver');
    expect(birth).toContain('Forge: GitLab (merge requests, MR).');
    expect(birth).toContain('merge request');
    expect(birth).not.toMatch(/pull request/i);
    const reviews = await promptsOf(sample, 'reviewer');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(
      'This merge request belongs to project sample',
    );
    expect(reviews[0]).not.toMatch(/pull request/i);
  });

  it('numbers voyages across every project and refuses a second open one', async () => {
    const { qd } = await start();
    expect(
      (await sendIntent(qd, 'voyage.start', { goal: 'First' })).body,
    ).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ voyage: 1 }),
      }),
    );
    const again = await sendIntent(qd, 'voyage.start', { goal: 'Second' });
    expect(again).toEqual({
      status: 409,
      body: { error: 'voyage 1 is still open; end it first' },
    });
    expect((await sendIntent(qd, 'voyage.kill', { voyage: 1 })).status).toBe(
      200,
    );
    const next = await sendIntent(qd, 'voyage.start', { goal: 'Second' });
    expect(next.body).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ voyage: 2 }),
      }),
    );
    expect((await sendIntent(qd, 'voyage.end', { voyage: 1 })).status).toBe(
      409,
    );
  });

  const startBoth = async (qd: Quarterdeck): Promise<void> => {
    await sendIntent(qd, 'voyage.start', { goal: 'Ship both' });
    for (const project of PROJECTS) {
      const store = storeOf(qd, project);
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'voyage.settling')).toHaveLength(1);
      }, WAIT);
    }
  };

  const startUnhurried = async (): ReturnType<typeof start> => {
    await writeMachineRule(homeDir, 'lifecycle.json', {
      autoEndSettleSeconds: 600,
      mergeGate: { autoMerge: false },
    });
    return start();
  };

  it.each([
    ['example', 'sample'],
    ['sample', 'example'],
  ])(
    'ends the voyage in the other project when %s closes',
    async (closed, kept) => {
      const { qd } = await startUnhurried();
      await startBoth(qd);

      const wiped = await sendIntent(qd, 'wipe.project', {
        project: closed,
        confirm: closed,
      });
      expect(wiped.status).toBe(200);

      const store = storeOf(qd, kept);
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'voyage.ended')).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ reason: 'project_closed' }),
          }),
        ]);
      }, WAIT);
      expect(
        (await sendIntent(qd, 'voyage.start', { goal: 'Again' })).body,
      ).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({ voyage: 2, projects: [kept] }),
        }),
      );
    },
  );

  const failRetireOnce = (qd: Quarterdeck, project: string): void => {
    const lifecycle = qd.projects.get(project)?.crew?.lifecycle;
    if (lifecycle === undefined) throw new Error(`${project} has no crew`);
    vi.spyOn(lifecycle, 'retire').mockRejectedValueOnce(new Error('disk full'));
  };

  it('keeps a voyage Kill all could not end everywhere, so Kill all can finish it', async () => {
    const { qd } = await startUnhurried();
    const [example, sample] = PROJECTS.map((project) =>
      storeOf(qd, project),
    ) as [Store, Store];
    await startBoth(qd);
    failRetireOnce(qd, 'sample');

    const first = await sendIntent(qd, 'voyage.kill', { voyage: 1 });
    expect(first).toEqual({
      status: 409,
      body: { error: 'voyage 1 is still open in sample; Kill all to end it' },
    });
    expect(await voyageStatus(example)).toBe('ended');
    expect(await voyageStatus(sample)).toBe('active');
    expect(
      (await sendIntent(qd, 'voyage.start', { goal: 'Too soon' })).status,
    ).toBe(409);

    expect((await sendIntent(qd, 'voyage.kill', { voyage: 1 })).status).toBe(
      200,
    );
    expect(await voyageStatus(sample)).toBe('ended');
  });

  it('ends every project’s row when one fails during End', async () => {
    const { qd } = await startUnhurried();
    const stores = PROJECTS.map((project) => storeOf(qd, project));
    await startBoth(qd);
    failRetireOnce(qd, 'sample');

    expect((await sendIntent(qd, 'voyage.end', { voyage: 1 })).status).toBe(
      202,
    );
    for (const store of stores) {
      await vi.waitFor(async () => {
        expect(await voyageStatus(store)).toBe('ended');
      }, WAIT);
    }
    await vi.waitFor(async () => {
      expect(
        (await sendIntent(qd, 'voyage.start', { goal: 'Next' })).status,
      ).toBe(200);
    }, WAIT);
  });

  it('replaces a reviewer whose seat in a project was killed, so that project is reviewed', async () => {
    const { qd } = await startUnhurried();
    const sample = storeOf(qd, 'sample');
    await startBoth(qd);
    await vi.waitFor(async () => {
      expect((await agentsOf(sample, 'reviewer'))[0]?.status).toBe('idle');
    }, WAIT);
    const [killed] = await agentsOf(sample, 'reviewer');
    expect(
      (
        await sendIntent(qd, 'agent.kill', {
          project: 'sample',
          agentId: killed?.id,
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(async () => {
      expect((await agentsOf(sample, 'reviewer'))[0]?.status).toBe('killed');
    }, WAIT);

    const ticketId = await proposeTicket(sample, 'Add a greeting');
    await sendIntent(qd, 'ticket.approve', { project: 'sample', ticketId });

    await vi.waitFor(async () => {
      expect(await eventsOf(sample, 'ticket.verdict')).toEqual([
        expect.objectContaining({
          ticketId,
          payload: expect.objectContaining({ decision: 'approve' }),
        }),
      ]);
    }, WAIT);
    const [verdict] = await eventsOf(sample, 'ticket.verdict');
    expect(verdict?.agentId).not.toBe(killed?.id);
  });
});
