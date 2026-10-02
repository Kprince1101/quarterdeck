import type { BudgetWindow } from '@quarterdeck/rules';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  BUDGET_EVENTS,
  checkLaunchBudget,
  readBudgetMeter,
} from '../../src/budget/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';

const TIMEOUT = 30_000;
const HOUR = 3_600_000;
const NOW = new Date('2026-10-01T12:00:00.000Z');
const CAPPED: BudgetWindow = { hours: 5, capTokens: 1000, holdAtFraction: 0.8 };
const UNCAPPED: BudgetWindow = { ...CAPPED, capTokens: null };

const hoursAgo = (hours: number, from = NOW): Date =>
  new Date(from.getTime() - hours * HOUR);

describe('budget meter and launch hold', () => {
  let store: Store;
  let agentId: string;
  let ticketId: string;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  const insertAgent = async (projectId: string): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role) values ($1, 'kite', 'builder')
       returning id`,
      [projectId],
    );
    return rows[0]!.id;
  };

  let seq = 0;
  const insertTurn = async (
    tokens: { input: number; output: number },
    endedAt: Date | null,
    agent = agentId,
  ): Promise<void> => {
    seq += 1;
    await store.db.query(
      `insert into turns
         (agent_id, seq, prompt, input_tokens, output_tokens, started_at, ended_at)
       values ($1, $2, 'go', $3, $4, $5, $6)`,
      [
        agent,
        seq,
        tokens.input,
        tokens.output,
        endedAt ?? hoursAgo(0.1),
        endedAt,
      ],
    );
  };

  const spend = (total: number, endedAt: Date) =>
    insertTurn(
      { input: total - Math.floor(total / 4), output: Math.floor(total / 4) },
      endedAt,
    );

  const budgetEvents = async () => {
    const { rows } = await store.db.query<{
      kind: string;
      agentId: string | null;
      ticketId: string | null;
      payload: Record<string, unknown>;
    }>(
      `select kind, agent_id as "agentId", ticket_id as "ticketId", payload
       from events where kind like 'budget.%' order by id`,
    );
    return rows;
  };

  beforeEach(async () => {
    agentId = await insertAgent(store.projectId);
    const { rows } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title) values ($1, 'QD5k') returning id`,
      [store.projectId],
    );
    ticketId = rows[0]!.id;
  });

  afterEach(async () => {
    await store.db.exec(
      `delete from events; delete from turns; delete from tickets;
       delete from agents; delete from projects where slug <> 'deck';`,
    );
  });

  describe('readBudgetMeter', () => {
    it('sums input and output tokens of turns that ended inside the window', async () => {
      await spend(300, hoursAgo(4.9));
      await spend(200, hoursAgo(0.5));
      await spend(5000, hoursAgo(5));
      await spend(7000, hoursAgo(6));
      await insertTurn({ input: 900, output: 0 }, null);

      const meter = await readBudgetMeter(
        store.db,
        store.projectId,
        CAPPED,
        NOW,
      );

      expect(meter).toEqual({
        windowHours: 5,
        since: hoursAgo(5),
        usedTokens: 500,
        capTokens: 1000,
        holdAtTokens: 800,
        held: false,
        releaseAt: null,
      });
    });

    it("leaves out another project's turns in the same database", async () => {
      const { rows } = await store.db.query<{ id: string }>(
        `insert into projects (slug, name) values ('other', 'other') returning id`,
      );
      const other = await insertAgent(rows[0]!.id);
      await insertTurn({ input: 5000, output: 0 }, hoursAgo(1), other);
      await spend(100, hoursAgo(1));

      const meter = await readBudgetMeter(
        store.db,
        store.projectId,
        CAPPED,
        NOW,
      );

      expect(meter.usedTokens).toBe(100);
    });

    it('has no hold line and never holds when the cap is null', async () => {
      await spend(1_000_000, hoursAgo(1));

      const meter = await readBudgetMeter(
        store.db,
        store.projectId,
        UNCAPPED,
        NOW,
      );

      expect(meter).toMatchObject({
        usedTokens: 1_000_000,
        capTokens: null,
        holdAtTokens: null,
        held: false,
        releaseAt: null,
      });
    });

    it('holds from the hold fraction of the cap, rounding the line up', async () => {
      await spend(799, hoursAgo(1));
      const under = await readBudgetMeter(
        store.db,
        store.projectId,
        CAPPED,
        NOW,
      );
      await spend(1, hoursAgo(1));
      const at = await readBudgetMeter(store.db, store.projectId, CAPPED, NOW);
      const odd = await readBudgetMeter(
        store.db,
        store.projectId,
        { ...CAPPED, capTokens: 999 },
        NOW,
      );

      expect(under.held).toBe(false);
      expect(at.held).toBe(true);
      expect(odd).toMatchObject({ holdAtTokens: 800, held: true });
    });

    it('releases when enough of the oldest spend leaves the window', async () => {
      await spend(500, hoursAgo(4));
      await spend(200, hoursAgo(3));
      await spend(600, hoursAgo(1));

      const meter = await readBudgetMeter(
        store.db,
        store.projectId,
        CAPPED,
        NOW,
      );
      const releaseAt = meter.releaseAt!;
      const before = await readBudgetMeter(
        store.db,
        store.projectId,
        CAPPED,
        new Date(releaseAt.getTime() - 1),
      );
      const later = await readBudgetMeter(
        store.db,
        store.projectId,
        CAPPED,
        releaseAt,
      );

      expect(meter).toMatchObject({ usedTokens: 1300, held: true });
      expect(releaseAt).toEqual(new Date(hoursAgo(3).getTime() + 5 * HOUR));
      expect(before).toMatchObject({ usedTokens: 800, held: true });
      expect(later).toMatchObject({ usedTokens: 600, held: false });
    });
  });

  describe('checkLaunchBudget', () => {
    it('clears a launch with no cap and records nothing', async () => {
      await spend(1_000_000, hoursAgo(1));

      const decision = await checkLaunchBudget(store, UNCAPPED, { now: NOW });

      expect(decision).toMatchObject({ status: 'clear', released: null });
      expect(await budgetEvents()).toEqual([]);
    });

    it('clears a launch under the hold line and records nothing', async () => {
      await spend(799, hoursAgo(1));

      const decision = await checkLaunchBudget(store, CAPPED, {
        ticketId,
        now: NOW,
      });

      expect(decision.status).toBe('clear');
      expect(await budgetEvents()).toEqual([]);
    });

    it('holds every launch at the hold line with an event each', async () => {
      await spend(900, hoursAgo(2));

      const first = await checkLaunchBudget(store, CAPPED, {
        ticketId,
        now: NOW,
      });
      const second = await checkLaunchBudget(store, CAPPED, {
        agentId,
        ticketId,
        now: NOW,
      });

      expect(first.status).toBe('held');
      expect(second.status).toBe('held');
      const payload = {
        windowHours: 5,
        usedTokens: 900,
        capTokens: 1000,
        holdAtTokens: 800,
        releaseAt: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
      };
      expect(await budgetEvents()).toEqual([
        { kind: BUDGET_EVENTS.held, agentId: null, ticketId, payload },
        { kind: BUDGET_EVENTS.held, agentId, ticketId, payload },
      ]);
      if (first.status === 'held') expect(first.event.kind).toBe('budget.held');
    });

    it('records one release once a held project is under the line again', async () => {
      await spend(900, hoursAgo(2));
      const held = await checkLaunchBudget(store, CAPPED, {
        ticketId,
        now: NOW,
      });
      const releaseAt = held.meter.releaseAt!;

      const cleared = await checkLaunchBudget(store, CAPPED, {
        ticketId,
        now: releaseAt,
      });
      const again = await checkLaunchBudget(store, CAPPED, { now: releaseAt });

      expect(cleared).toMatchObject({
        status: 'clear',
        released: { kind: BUDGET_EVENTS.released },
      });
      expect(again).toMatchObject({ status: 'clear', released: null });
      expect((await budgetEvents()).map(({ kind }) => kind)).toEqual([
        BUDGET_EVENTS.held,
        BUDGET_EVENTS.released,
      ]);
      expect((await budgetEvents())[1]).toMatchObject({
        agentId: null,
        ticketId: null,
        payload: { usedTokens: 0, capTokens: 1000, releaseAt: null },
      });
    });

    it('releases a held project when the cap is lifted', async () => {
      await spend(900, hoursAgo(2));
      await checkLaunchBudget(store, CAPPED, { now: NOW });

      const decision = await checkLaunchBudget(store, UNCAPPED, { now: NOW });

      expect(decision).toMatchObject({
        status: 'clear',
        released: { payload: { usedTokens: 900, capTokens: null } },
      });
    });

    it('records one release when launches are checked together', async () => {
      await spend(900, hoursAgo(2));
      await checkLaunchBudget(store, CAPPED, { now: NOW });
      const later = new Date(NOW.getTime() + 4 * HOUR);

      const decisions = await Promise.all(
        [1, 2, 3].map(() => checkLaunchBudget(store, CAPPED, { now: later })),
      );

      expect(decisions.every(({ status }) => status === 'clear')).toBe(true);
      expect((await budgetEvents()).map(({ kind }) => kind)).toEqual([
        BUDGET_EVENTS.held,
        BUDGET_EVENTS.released,
      ]);
    });
  });
});
