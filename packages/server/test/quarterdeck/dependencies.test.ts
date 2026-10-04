import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREW_FAILED_EVENT } from '../../src/crew/index.js';
import {
  startQuarterdeck,
  type Quarterdeck,
} from '../../src/quarterdeck/index.js';
import type { Store } from '../../src/store/index.js';
import {
  FAKE_PACKAGE,
  FAKE_VERSION,
  FAKE_WAIT_MARKER,
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

const LIBRARY = 'library';
const RETROFIT = 'retrofit';

const ticketStatus = (
  store: Store,
  ticketId: string,
): Promise<string | undefined> =>
  valueOf<string>(store, 'select status as value from tickets where id = $1', [
    ticketId,
  ]);

const proposeRetrofit = async (
  store: Store,
  libraryTicket: string,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into tickets (project_id, title, body, status)
     values ($1, $2, $3, 'proposed') returning id`,
    [
      store.projectId,
      `Adopt the library change, needs ticket ${libraryTicket}`,
      `Use the new library call. ${FAKE_WAIT_MARKER}`,
    ],
  );
  const [row] = rows;
  if (!row) throw new Error('the retrofit ticket was not proposed');
  return row.id;
};

const driverPrompts = async (store: Store): Promise<string[]> => {
  const { rows } = await store.db.query<{ prompt: string }>(
    `select t.prompt from turns t join agents a on a.id = t.agent_id
     where a.project_id = $1 and a.role = 'driver' order by t.id`,
    [store.projectId],
  );
  return rows.map(({ prompt }) => prompt);
};

describe('cross-project blocking and auto-wake', { timeout: TIMEOUT }, () => {
  let homeDir = '';
  const cleanup: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-depends-'));
    await writeMachineRule(homeDir, 'lifecycle.json', {
      autoEndSettleSeconds: 600,
      mergeGate: { autoMerge: true },
    });
  });

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    await rm(homeDir, { recursive: true, force: true });
  });

  const start = async (publishes: boolean): Promise<Quarterdeck> => {
    const runtime = crewRuntime({});
    const qd = await startQuarterdeck({
      port: 0,
      homeDir,
      adapters: runtime.adapters,
      forge: fakeGitHub(),
    });
    cleanup.push(() => qd.close());
    for (const project of [LIBRARY, RETROFIT]) {
      const repo = await createRepo();
      cleanup.push(() => rm(repo, { recursive: true, force: true }));
      const created = await sendIntent(qd, 'project.create', {
        project,
        repoPath: repo,
      });
      expect(created.status).toBe(200);
    }
    const set = await sendIntent(qd, 'services.set', {
      project: LIBRARY,
      publishes,
    });
    expect(set.status).toBe(200);
    const started = await sendIntent(qd, 'voyage.start', { goal: 'Retrofit' });
    expect(started.status).toBe(200);
    for (const project of [LIBRARY, RETROFIT]) {
      const store = storeOf(qd, project);
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'driver.voyage_started')).toHaveLength(1);
      }, WAIT);
    }
    return qd;
  };

  const blockRetrofit = async (
    qd: Quarterdeck,
  ): Promise<{ libraryTicket: string; retrofitTicket: string }> => {
    const library = storeOf(qd, LIBRARY);
    const retrofit = storeOf(qd, RETROFIT);
    const libraryTicket = await proposeTicket(library, 'Add the library call');
    const retrofitTicket = await proposeRetrofit(retrofit, libraryTicket);
    expect(
      (
        await sendIntent(qd, 'ticket.approve', {
          project: RETROFIT,
          ticketId: retrofitTicket,
        })
      ).status,
    ).toBe(200);
    await vi.waitFor(async () => {
      expect(await eventsOf(retrofit, 'ticket.blocked')).toEqual([
        expect.objectContaining({
          ticketId: retrofitTicket,
          payload: expect.objectContaining({
            reason: 'dependencies',
            previousStatus: 'assigned',
            dependsOn: [libraryTicket],
            unmet: [
              expect.objectContaining({
                ticket: libraryTicket,
                project: LIBRARY,
                reason: 'it is proposed',
              }),
            ],
          }),
        }),
      ]);
    }, WAIT);
    expect(await ticketStatus(retrofit, retrofitTicket)).toBe('blocked');
    expect(
      await valueOf(
        retrofit,
        'select depends_on as value from tickets where id = $1',
        [retrofitTicket],
      ),
    ).toEqual([libraryTicket]);
    const [assigned] = await eventsOf(retrofit, 'ticket.assigned');
    expect(
      await valueOf(
        retrofit,
        'select status as value from agents where id = $1',
        [assigned?.agentId],
      ),
    ).toBe('idle');
    expect(
      (
        await sendIntent(qd, 'ticket.approve', {
          project: LIBRARY,
          ticketId: libraryTicket,
        })
      ).status,
    ).toBe(200);
    return { libraryTicket, retrofitTicket };
  };

  it('wakes a retrofit builder blocked on a publishing library once the Driver records the published version', async () => {
    const qd = await start(true);
    const library = storeOf(qd, LIBRARY);
    const retrofit = storeOf(qd, RETROFIT);
    const { libraryTicket, retrofitTicket } = await blockRetrofit(qd);

    await vi.waitFor(async () => {
      expect(await eventsOf(library, 'ticket.published')).toEqual([
        expect.objectContaining({
          ticketId: libraryTicket,
          payload: { package: FAKE_PACKAGE, version: FAKE_VERSION },
        }),
      ]);
    }, WAIT);
    const prompts = await driverPrompts(library);
    expect(
      prompts.some(
        (prompt) =>
          prompt.includes(`(ticket ${libraryTicket}) merged`) &&
          prompt.includes('needs publishing'),
      ),
    ).toBe(true);

    await vi.waitFor(async () => {
      expect(await eventsOf(retrofit, 'builder.continued')).toHaveLength(1);
    }, WAIT);
    const [assigned] = await eventsOf(retrofit, 'ticket.assigned');
    const [continued] = await eventsOf(retrofit, 'builder.continued');
    expect(continued).toMatchObject({
      agentId: assigned?.agentId,
      ticketId: retrofitTicket,
    });
    const prompt = String(continued?.payload['prompt']);
    expect(prompt).toContain(`(ticket ${retrofitTicket}) is no longer blocked`);
    expect(prompt).toContain(`published ${FAKE_PACKAGE} ${FAKE_VERSION}`);
    expect(prompt).toContain('Bump each published dependency');
    expect(await eventsOf(retrofit, 'ticket.unblocked')).toEqual([
      expect.objectContaining({
        ticketId: retrofitTicket,
        agentId: assigned?.agentId,
        payload: expect.objectContaining({
          held: true,
          status: 'assigned',
          dependencies: [
            expect.objectContaining({
              ticket: libraryTicket,
              project: LIBRARY,
              package: FAKE_PACKAGE,
              version: FAKE_VERSION,
            }),
          ],
        }),
      }),
    ]);
    expect(await ticketStatus(retrofit, retrofitTicket)).toBe('assigned');

    await qd.coordinator.idle();
    expect(await eventsOf(retrofit, 'builder.continued')).toHaveLength(1);
    expect(await eventsOf(retrofit, 'ticket.unblocked')).toHaveLength(1);
    for (const store of [library, retrofit])
      expect(await eventsOf(store, CREW_FAILED_EVENT)).toEqual([]);
  });

  it('wakes a builder blocked on a project that does not publish once its dependency is done', async () => {
    const qd = await start(false);
    const library = storeOf(qd, LIBRARY);
    const retrofit = storeOf(qd, RETROFIT);
    const { libraryTicket, retrofitTicket } = await blockRetrofit(qd);

    await vi.waitFor(async () => {
      expect(await eventsOf(retrofit, 'builder.continued')).toHaveLength(1);
    }, WAIT);
    const [continued] = await eventsOf(retrofit, 'builder.continued');
    expect(String(continued?.payload['prompt'])).toContain(
      `${libraryTicket} ("Add the library call", project ${LIBRARY}): merged`,
    );
    expect(await ticketStatus(library, libraryTicket)).toBe('done');
    expect(await eventsOf(library, 'ticket.published')).toEqual([]);
    expect(
      (await driverPrompts(library)).some((prompt) =>
        prompt.includes('needs publishing'),
      ),
    ).toBe(false);
    expect(await ticketStatus(retrofit, retrofitTicket)).toBe('assigned');
  });
});
