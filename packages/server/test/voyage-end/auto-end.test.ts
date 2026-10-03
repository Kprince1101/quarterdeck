import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { GATE_EVENTS } from '../../src/gate/index.js';
import {
  AUTO_END_EVENTS,
  isSettled,
  readSettleState,
  startAutoEnd,
  type AutoEnd,
} from '../../src/voyage-end/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  CLEAR_VOYAGE_TABLES,
  TIMEOUT,
  eventPayloads,
  fakeScheduler,
  insertAgent,
  insertCard,
  insertVoyage,
  insertTicket,
  type FakeScheduler,
} from './fixtures.js';

const SETTLE_SECONDS = 120;
const HOME = join(tmpdir(), 'qd-auto-end-home-never-created');

describe('auto-end', { timeout: TIMEOUT }, () => {
  let store: Store;
  let scheduler: FakeScheduler;
  let ended: string[];
  let errors: unknown[];
  let auto: AutoEnd | undefined;
  let voyageId: string;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    scheduler = fakeScheduler();
    ended = [];
    errors = [];
    voyageId = await insertVoyage(store, 1);
  });

  afterEach(async () => {
    await auto?.close();
    auto = undefined;
    await store.db.exec(CLEAR_VOYAGE_TABLES);
  });

  const start = async (): Promise<AutoEnd> => {
    auto = await startAutoEnd({
      legs: [{ store, voyageId }],
      settleSeconds: SETTLE_SECONDS,
      schedule: scheduler.schedule,
      home: HOME,
      end: async () => {
        ended.push(voyageId);
      },
      onError: (err) => {
        errors.push(err);
      },
    });
    await auto.check();
    return auto;
  };

  const settling = () => eventPayloads(store, AUTO_END_EVENTS.settling);

  it('reads what keeps a voyage from settling', async () => {
    await insertTicket(store, 'in_review');
    await insertTicket(store, 'done');
    await insertTicket(store, 'proposed');
    await insertAgent(store, { name: 'heron', status: 'working' });
    await insertAgent(store, { name: 'pike', status: 'idle' });
    await insertCard(store);

    const state = await readSettleState(
      store.db,
      store.projectId,
      voyageId,
      HOME,
    );

    expect(state).toEqual({
      voyageEnded: false,
      openTickets: 1,
      runningAgents: 1,
      openCards: 1,
      paused: false,
    });
    expect(isSettled(state)).toBe(false);
    const quiet = {
      voyageEnded: false,
      openTickets: 0,
      runningAgents: 0,
      openCards: 0,
      paused: false,
    };
    expect(isSettled(quiet)).toBe(true);
    expect(isSettled({ ...quiet, paused: true })).toBe(false);
  });

  it('never settles while the project is paused, and settles on unpause', async () => {
    const setPaused = async (paused: boolean) => {
      await store.db.query(
        `update projects set paused_at = case when $2::boolean then now() end
         where id = $1`,
        [store.projectId, paused],
      );
      await store.publish({ kind: 'pause.set' });
    };
    await setPaused(true);
    try {
      await start();
      expect(scheduler.live()).toEqual([]);
      expect(
        (await readSettleState(store.db, store.projectId, voyageId, HOME))
          .paused,
      ).toBe(true);

      await setPaused(false);

      await vi.waitFor(() => {
        expect(scheduler.live()).toHaveLength(1);
      });
    } finally {
      await store.db.query(
        'update projects set paused_at = null where id = $1',
        [store.projectId],
      );
    }
  });

  it('arms the settle timer at once when the voyage is already settled, and ends it when it fires', async () => {
    await insertTicket(store, 'done');
    await insertAgent(store, { name: 'heron', status: 'idle', voyageId });
    await start();

    expect(scheduler.live()).toHaveLength(1);
    expect(scheduler.live()[0]?.ms).toBe(SETTLE_SECONDS * 1000);
    expect(await settling()).toEqual([
      { voyageId, settleSeconds: SETTLE_SECONDS, rearmed: false },
    ]);

    scheduler.live()[0]?.fire();

    await vi.waitFor(() => {
      expect(ended).toEqual([voyageId]);
    });
    expect(await eventPayloads(store, AUTO_END_EVENTS.settled)).toEqual([
      { voyageId, settleSeconds: SETTLE_SECONDS },
    ]);
    expect(errors).toEqual([]);
  });

  it('waits for open tickets, running agents and open cards to clear', async () => {
    const ticketId = await insertTicket(store, 'in_progress');
    const agentId = await insertAgent(store, {
      name: 'heron',
      status: 'working',
    });
    const cardId = await insertCard(store);
    await start();
    expect(scheduler.timers).toEqual([]);

    await store.db.query(`update tickets set status = 'done' where id = $1`, [
      ticketId,
    ]);
    await store.db.query(`update agents set status = 'idle' where id = $1`, [
      agentId,
    ]);
    await auto?.check();
    expect(scheduler.timers).toEqual([]);

    await store.db.query(
      `update cards set status = 'answered', answer = 'yes' where id = $1`,
      [cardId],
    );

    await vi.waitFor(() => {
      expect(scheduler.live()).toHaveLength(1);
    });
  });

  it('disarms when work comes back before the timer fires', async () => {
    await start();
    const [armed] = scheduler.live();

    await insertCard(store);

    await vi.waitFor(() => {
      expect(armed?.cancelled).toBe(true);
    });
    expect(scheduler.live()).toEqual([]);
  });

  it('re-arms the settle timer on a late merge', async () => {
    await start();
    const [first] = scheduler.live();

    await store.publish({
      kind: GATE_EVENTS.merged,
      payload: { pr: 'https://github.com/o/r/pull/1', head: 'abc', by: 'gate' },
    });

    await vi.waitFor(() => {
      expect(first?.cancelled).toBe(true);
      expect(scheduler.live()).toHaveLength(1);
    });
    expect(await settling()).toEqual([
      { voyageId, settleSeconds: SETTLE_SECONDS, rearmed: false },
      { voyageId, settleSeconds: SETTLE_SECONDS, rearmed: true },
    ]);
  });

  it('does not re-arm on other table changes while settled', async () => {
    await start();
    await insertTicket(store, 'done');
    await auto?.check();

    expect(scheduler.timers).toHaveLength(1);
    expect(await settling()).toHaveLength(1);
  });

  it('does not end a voyage that is no longer settled when the timer fires', async () => {
    await start();
    const [armed] = scheduler.live();
    await insertTicket(store, 'open');

    armed?.fire();

    await auto?.check();
    expect(ended).toEqual([]);
    expect(await eventPayloads(store, AUTO_END_EVENTS.settled)).toEqual([]);
  });

  it('ends a voyage once, however often the timer fires', async () => {
    await start();
    const [armed] = scheduler.live();

    armed?.fire();
    armed?.fire();

    await vi.waitFor(() => {
      expect(ended).toEqual([voyageId]);
    });
    await auto?.check();
    expect(scheduler.timers).toHaveLength(1);
    expect(await eventPayloads(store, AUTO_END_EVENTS.settled)).toHaveLength(1);
  });

  it('never arms for a voyage that has ended', async () => {
    await store.db.query(`update voyages set status = 'ended' where id = $1`, [
      voyageId,
    ]);

    await start();

    expect(scheduler.timers).toEqual([]);
  });

  it('cancels the timer on close', async () => {
    await start();
    const [armed] = scheduler.live();

    await auto?.close();

    expect(armed?.cancelled).toBe(true);
  });
});
