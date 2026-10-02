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
} from '../../src/round-end/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  CLEAR_ROUND_TABLES,
  TIMEOUT,
  eventPayloads,
  fakeScheduler,
  insertAgent,
  insertCard,
  insertRound,
  insertTicket,
  type FakeScheduler,
} from './fixtures.js';

const SETTLE_SECONDS = 120;

describe('auto-end', { timeout: TIMEOUT }, () => {
  let store: Store;
  let scheduler: FakeScheduler;
  let ended: string[];
  let errors: unknown[];
  let auto: AutoEnd | undefined;
  let roundId: string;

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
    roundId = await insertRound(store, 1);
  });

  afterEach(async () => {
    await auto?.close();
    auto = undefined;
    await store.db.exec(CLEAR_ROUND_TABLES);
  });

  const start = async (): Promise<AutoEnd> => {
    auto = await startAutoEnd({
      store,
      roundId,
      settleSeconds: SETTLE_SECONDS,
      schedule: scheduler.schedule,
      end: async (id) => {
        ended.push(id);
      },
      onError: (err) => {
        errors.push(err);
      },
    });
    await auto.check();
    return auto;
  };

  const settling = () => eventPayloads(store, AUTO_END_EVENTS.settling);

  it('reads what keeps a round from settling', async () => {
    await insertTicket(store, 'in_review');
    await insertTicket(store, 'done');
    await insertTicket(store, 'proposed');
    await insertAgent(store, { name: 'heron', status: 'working' });
    await insertAgent(store, { name: 'pike', status: 'idle' });
    await insertCard(store);

    const state = await readSettleState(store.db, store.projectId, roundId);

    expect(state).toEqual({
      roundEnded: false,
      openTickets: 1,
      runningAgents: 1,
      openCards: 1,
    });
    expect(isSettled(state)).toBe(false);
    expect(
      isSettled({
        roundEnded: false,
        openTickets: 0,
        runningAgents: 0,
        openCards: 0,
      }),
    ).toBe(true);
  });

  it('arms the settle timer at once when the round is already settled, and ends it when it fires', async () => {
    await insertTicket(store, 'done');
    await insertAgent(store, { name: 'heron', status: 'idle', roundId });
    await start();

    expect(scheduler.live()).toHaveLength(1);
    expect(scheduler.live()[0]?.ms).toBe(SETTLE_SECONDS * 1000);
    expect(await settling()).toEqual([
      { roundId, settleSeconds: SETTLE_SECONDS, rearmed: false },
    ]);

    scheduler.live()[0]?.fire();

    await vi.waitFor(() => {
      expect(ended).toEqual([roundId]);
    });
    expect(await eventPayloads(store, AUTO_END_EVENTS.settled)).toEqual([
      { roundId, settleSeconds: SETTLE_SECONDS },
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
      { roundId, settleSeconds: SETTLE_SECONDS, rearmed: false },
      { roundId, settleSeconds: SETTLE_SECONDS, rearmed: true },
    ]);
  });

  it('does not re-arm on other table changes while settled', async () => {
    await start();
    await insertTicket(store, 'done');
    await auto?.check();

    expect(scheduler.timers).toHaveLength(1);
    expect(await settling()).toHaveLength(1);
  });

  it('does not end a round that is no longer settled when the timer fires', async () => {
    await start();
    const [armed] = scheduler.live();
    await insertTicket(store, 'open');

    armed?.fire();

    await auto?.check();
    expect(ended).toEqual([]);
    expect(await eventPayloads(store, AUTO_END_EVENTS.settled)).toEqual([]);
  });

  it('ends a round once, however often the timer fires', async () => {
    await start();
    const [armed] = scheduler.live();

    armed?.fire();
    armed?.fire();

    await vi.waitFor(() => {
      expect(ended).toEqual([roundId]);
    });
    await auto?.check();
    expect(scheduler.timers).toHaveLength(1);
    expect(await eventPayloads(store, AUTO_END_EVENTS.settled)).toHaveLength(1);
  });

  it('never arms for a round that has ended', async () => {
    await store.db.query(`update rounds set status = 'ended' where id = $1`, [
      roundId,
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
