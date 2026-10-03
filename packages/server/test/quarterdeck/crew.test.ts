import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAcpClientCount } from '../../src/acp/client/index.js';
import { COORDINATOR_SITE, CREW_FAILED_EVENT } from '../../src/crew/index.js';
import {
  startQuarterdeck,
  type Quarterdeck,
  type QuarterdeckOptions,
} from '../../src/quarterdeck/index.js';
import type { Store } from '../../src/store/index.js';
import {
  FAKE_BUILDER_PUSH,
  FAKE_PR_HEAD,
  FAKE_PR_URL,
  FAKE_PROPOSAL_TITLE,
} from '../acp/fake-agent/index.ts';
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

const PROJECT = 'example';
const SAMPLE = 'sample';

describe('the crew under startQuarterdeck', { timeout: TIMEOUT }, () => {
  let homeDir = '';
  const cleanup: (() => Promise<void>)[] = [];

  const start = async (
    options: Partial<QuarterdeckOptions>,
  ): Promise<Quarterdeck> => {
    const qd = await startQuarterdeck({ port: 0, homeDir, ...options });
    cleanup.push(() => qd.close());
    return qd;
  };

  const openProject = async (
    qd: Quarterdeck,
    project: string,
  ): Promise<void> => {
    const repo = await createRepo();
    cleanup.push(() => rm(repo, { recursive: true, force: true }));
    const created = await sendIntent(qd, 'project.create', {
      project,
      repoPath: repo,
    });
    expect(created.status).toBe(200);
  };

  const startVoyage = async (qd: Quarterdeck, project: string) => {
    const reply = await sendIntent(qd, 'voyage.start', {
      goal: 'Ship the greeting',
    });
    expect(reply.status).toBe(200);
    const store = storeOf(qd, project);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'driver.voyage_started')).toHaveLength(1);
    }, WAIT);
    return store;
  };

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-crew-'));
    await writeMachineRule(homeDir, 'lifecycle.json', {
      autoEndSettleSeconds: 1,
      mergeGate: { autoMerge: true },
    });
  });

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('assigns an approved ticket, reviews and merges its pull request, and ends the voyage', async () => {
    const runtime = crewRuntime({});
    const github = fakeGitHub();
    const qd = await start({ adapters: runtime.adapters, forge: github });
    await openProject(qd, PROJECT);
    const store = await startVoyage(qd, PROJECT);
    const ticketId = await proposeTicket(store, 'Add a greeting');

    const approved = await sendIntent(qd, 'ticket.approve', {
      project: PROJECT,
      ticketId,
    });
    expect(approved.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'ticket.assigned')).toEqual([
        expect.objectContaining({ ticketId }),
      ]);
    }, WAIT);
    const [assigned] = await eventsOf(store, 'ticket.assigned');
    const builderId = assigned?.agentId;

    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'ticket.reported')).toEqual([
        expect.objectContaining({
          ticketId,
          agentId: builderId,
          payload: expect.objectContaining({
            pr: FAKE_PR_URL,
            head: FAKE_PR_HEAD,
          }),
        }),
      ]);
    }, WAIT);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'ticket.verdict')).toEqual([
        expect.objectContaining({
          ticketId,
          payload: expect.objectContaining({ decision: 'approve' }),
        }),
      ]);
    }, WAIT);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'ticket.merged')).toEqual([
        expect.objectContaining({
          ticketId,
          payload: expect.objectContaining({ by: 'gate' }),
        }),
      ]);
    }, WAIT);
    expect(github.merges).toEqual([{ url: FAKE_PR_URL, head: FAKE_PR_HEAD }]);
    expect(
      await valueOf(
        store,
        'select status as value from tickets where id = $1',
        [ticketId],
      ),
    ).toBe('done');

    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'voyage.ended')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ reason: 'settled' }),
        }),
      ]);
    }, WAIT);
    expect(await eventsOf(store, 'voyage.wrapped_up')).toHaveLength(1);
    expect(
      await valueOf(
        store,
        `select array_agg(role order by role) as value from agents
         where project_id = $1 and status <> 'retired'`,
        [store.projectId],
      ),
    ).toEqual(['reviewer']);
    expect(await eventsOf(store, CREW_FAILED_EVENT)).toEqual([]);
    expect(runtime.launches.map((launch) => launch.env)).toEqual(
      runtime.launches.map(() => ({ pass: [] })),
    );
  });

  it('cards the human when the Planner asks to propose, and proposes once allowed', async () => {
    const runtime = crewRuntime({});
    const qd = await start({ adapters: runtime.adapters });
    await openProject(qd, PROJECT);
    const store = storeOf(qd, PROJECT);

    const sent = await sendIntent(qd, 'planner.message', {
      project: PROJECT,
      text: 'Fix the greeting.',
    });
    expect(sent.status).toBe(202);
    await vi.waitFor(async () => {
      expect(
        await valueOf(
          store,
          `select count(*)::int as value from cards
           where project_id = $1 and kind = 'agent.permission' and status = 'open'`,
          [store.projectId],
        ),
      ).toBe(1);
    }, WAIT);
    const cardId = await valueOf<string>(
      store,
      `select id as value from cards where project_id = $1`,
      [store.projectId],
    );

    const answered = await sendIntent(qd, 'card.answer', {
      project: PROJECT,
      cardId,
      answer: 'allow',
    });
    expect(answered.status).toBe(200);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'ticket.proposed')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            title: FAKE_PROPOSAL_TITLE,
            project: PROJECT,
          }),
        }),
      ]);
    }, WAIT);
  });

  it('reads the Planner’s permissions from the home it was started with', async () => {
    await writeMachineRule(homeDir, 'permissions.json', {
      rules: [{ kind: 'other', decision: 'allow' }],
    });
    const runtime = crewRuntime({});
    const qd = await start({ adapters: runtime.adapters });
    await openProject(qd, PROJECT);
    const store = storeOf(qd, PROJECT);

    await sendIntent(qd, 'planner.message', {
      project: PROJECT,
      text: 'Fix the greeting.',
    });
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'ticket.proposed')).toHaveLength(1);
    }, WAIT);
    expect(
      await valueOf(
        store,
        'select count(*)::int as value from cards where project_id = $1',
        [store.projectId],
      ),
    ).toBe(0);
  });

  const reportAfterAsking = async (): Promise<Store> => {
    const runtime = crewRuntime({ [PROJECT]: { builderAsks: true } });
    const qd = await start({
      adapters: runtime.adapters,
      forge: fakeGitHub(),
    });
    await openProject(qd, PROJECT);
    const store = await startVoyage(qd, PROJECT);
    const ticketId = await proposeTicket(store, 'Add a greeting');
    await sendIntent(qd, 'ticket.approve', { project: PROJECT, ticketId });
    return store;
  };

  const permissionCards = (store: Store): Promise<number | undefined> =>
    valueOf<number>(
      store,
      `select count(*)::int as value from cards
       where project_id = $1 and kind = 'agent.permission'`,
      [store.projectId],
    );

  it('reads a builder’s permissions from the home it was started with', async () => {
    await writeMachineRule(homeDir, 'permissions.json', {
      rules: [
        { kind: 'execute', pattern: FAKE_BUILDER_PUSH, decision: 'allow' },
      ],
    });
    const store = await reportAfterAsking();
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'ticket.reported')).toHaveLength(1);
    }, WAIT);
    expect(await permissionCards(store)).toBe(0);
  });

  it('cards a builder’s push when the home allows nothing', async () => {
    const store = await reportAfterAsking();
    await vi.waitFor(async () => {
      expect(await permissionCards(store)).toBe(1);
    }, WAIT);
    expect(await eventsOf(store, 'ticket.reported')).toEqual([]);
  });

  it('passes the Agents widget’s poke and kill to the live Driver', async () => {
    const runtime = crewRuntime({});
    const qd = await start({
      adapters: runtime.adapters,
      forge: fakeGitHub(),
    });
    await openProject(qd, PROJECT);
    const store = await startVoyage(qd, PROJECT);
    const [started] = await eventsOf(store, 'driver.voyage_started');
    const driverId = started?.agentId;

    const poked = await sendIntent(qd, 'agent.message', {
      project: PROJECT,
      agentId: driverId,
      text: 'How is the voyage going?',
    });
    expect(poked.status).toBe(202);
    await vi.waitFor(async () => {
      expect(
        await valueOf(
          store,
          `select count(*)::int as value from turns
           where agent_id = $1 and prompt like '%Message from the human: How is the voyage going?%'`,
          [driverId],
        ),
      ).toBe(1);
    }, WAIT);

    const killed = await sendIntent(qd, 'agent.kill', {
      project: PROJECT,
      agentId: driverId,
    });
    expect(killed.status).toBe(202);
    await vi.waitFor(async () => {
      expect(
        await valueOf(
          store,
          'select status as value from agents where id = $1',
          [driverId],
        ),
      ).toBe('killed');
    }, WAIT);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'agent.killed')).toEqual([
        expect.objectContaining({ agentId: driverId }),
      ]);
    }, WAIT);
  });

  it('stops every agent on close and ends the voyage it left open at the next start', async () => {
    const runtime = crewRuntime({});
    const first = await start({ adapters: runtime.adapters });
    await openProject(first, PROJECT);
    await startVoyage(first, PROJECT);
    expect(openAcpClientCount()).toBeGreaterThan(0);

    await first.close();
    expect(openAcpClientCount()).toBe(0);

    const second = await start({ adapters: runtime.adapters });
    const store = storeOf(second, PROJECT);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'voyage.ended')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ reason: 'restart' }),
        }),
      ]);
    }, WAIT);
    expect(
      await valueOf(
        store,
        `select count(*)::int as value from agents
         where project_id = $1 and status <> 'retired'`,
        [store.projectId],
      ),
    ).toBe(0);
  });

  it('keeps the API running when the Driver dies, and ends its voyage on request', async () => {
    const runtime = crewRuntime({ [COORDINATOR_SITE]: { crashDriver: true } });
    const qd = await start({
      adapters: runtime.adapters,
      forge: fakeGitHub(),
    });
    await openProject(qd, SAMPLE);
    await openProject(qd, PROJECT);

    const sample = await startVoyage(qd, SAMPLE);
    await vi.waitFor(async () => {
      expect(await eventsOf(sample, CREW_FAILED_EVENT)).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ service: 'driver' }),
        }),
      );
    }, WAIT);

    expect(
      (
        await sendIntent(qd, 'notebook.add', {
          project: SAMPLE,
          body: 'still answering',
        })
      ).status,
    ).toBe(200);
    expect(
      (await sendIntent(qd, 'voyage.start', { goal: 'Another' })).status,
    ).toBe(409);

    expect((await sendIntent(qd, 'voyage.end', { voyage: 1 })).status).toBe(
      202,
    );
    for (const project of [SAMPLE, PROJECT]) {
      const store = storeOf(qd, project);
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'voyage.ended')).toHaveLength(1);
      }, WAIT);
    }
  });
});
