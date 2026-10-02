import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAcpClientCount } from '../../src/acp/client/index.js';
import { CREW_FAILED_EVENT } from '../../src/crew/index.js';
import {
  startQuarterdeck,
  type Quarterdeck,
  type QuarterdeckOptions,
} from '../../src/quarterdeck/index.js';
import { FAKE_PR_HEAD, FAKE_PR_URL } from '../acp/fake-agent/index.ts';
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
const BROKEN = 'sample';

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

  const startRound = async (qd: Quarterdeck, project: string) => {
    const reply = await sendIntent(qd, 'round.start', {
      project,
      goal: 'Ship the greeting',
    });
    expect(reply.status).toBe(202);
    const store = storeOf(qd, project);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'driver.round_started')).toHaveLength(1);
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

  it('assigns an approved ticket, reviews and merges its pull request, and ends the round', async () => {
    const runtime = crewRuntime({});
    const github = fakeGitHub();
    const qd = await start({ adapters: runtime.adapters, github });
    await openProject(qd, PROJECT);
    const store = await startRound(qd, PROJECT);
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
      expect(await eventsOf(store, 'round.ended')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ reason: 'settled' }),
        }),
      ]);
    }, WAIT);
    expect(await eventsOf(store, 'round.wrapped_up')).toHaveLength(1);
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

  it('passes the Agents widget’s poke and kill to the live Driver', async () => {
    const runtime = crewRuntime({});
    const qd = await start({
      adapters: runtime.adapters,
      github: fakeGitHub(),
    });
    await openProject(qd, PROJECT);
    const store = await startRound(qd, PROJECT);
    const [started] = await eventsOf(store, 'driver.round_started');
    const driverId = started?.agentId;

    const poked = await sendIntent(qd, 'agent.message', {
      project: PROJECT,
      agentId: driverId,
      text: 'How is the round going?',
    });
    expect(poked.status).toBe(202);
    await vi.waitFor(async () => {
      expect(
        await valueOf(
          store,
          `select count(*)::int as value from turns
           where agent_id = $1 and prompt like '%Message from the human: How is the round going?%'`,
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
    expect(await eventsOf(store, 'agent.killed')).toEqual([
      expect.objectContaining({ agentId: driverId }),
    ]);
  });

  it('stops every agent on close and ends the round it left open at the next start', async () => {
    const runtime = crewRuntime({});
    const first = await start({ adapters: runtime.adapters });
    await openProject(first, PROJECT);
    await startRound(first, PROJECT);
    expect(openAcpClientCount()).toBeGreaterThan(0);

    await first.close();
    expect(openAcpClientCount()).toBe(0);

    const second = await start({ adapters: runtime.adapters });
    const store = storeOf(second, PROJECT);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'round.ended')).toEqual([
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

  it('keeps the API and other projects running when one project’s Driver dies', async () => {
    const runtime = crewRuntime({ [BROKEN]: { crashDriver: true } });
    const qd = await start({
      adapters: runtime.adapters,
      github: fakeGitHub(),
    });
    await openProject(qd, BROKEN);
    await openProject(qd, PROJECT);

    const broken = await startRound(qd, BROKEN);
    await vi.waitFor(async () => {
      expect(await eventsOf(broken, CREW_FAILED_EVENT)).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ service: 'driver' }),
        }),
      );
    }, WAIT);

    expect(
      (
        await sendIntent(qd, 'notebook.add', {
          project: BROKEN,
          body: 'still answering',
        })
      ).status,
    ).toBe(200);

    const store = await startRound(qd, PROJECT);
    const ticketId = await proposeTicket(store, 'Add a greeting');
    expect(
      (await sendIntent(qd, 'ticket.approve', { project: PROJECT, ticketId }))
        .status,
    ).toBe(200);
    await vi.waitFor(async () => {
      expect(await eventsOf(store, 'ticket.assigned')).toEqual([
        expect.objectContaining({ ticketId }),
      ]);
    }, WAIT);
    expect(await eventsOf(store, CREW_FAILED_EVENT)).toEqual([]);
  });
});
