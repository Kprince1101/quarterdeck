import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROCESS_SWEPT_EVENT } from '../../src/agents/index.js';
import { recoverProject } from '../../src/lifecycle/index.js';
import { PAUSE_EVENTS } from '../../src/pause/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  CLEAR_VOYAGE_TABLES,
  eventPayloads,
  insertAgent,
  insertTicket,
} from '../voyage-end/fixtures.js';
import {
  GRACE_MS,
  IS_WINDOWS,
  TIMEOUT,
  exitOf,
  giveProcess,
  isRunning,
  startSleeper,
  stopSleepers,
  storedPid,
} from './fixtures.js';

describe('recovering a project at startup', { timeout: TIMEOUT }, () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  afterEach(async () => {
    stopSleepers();
    await store.db.exec(CLEAR_VOYAGE_TABLES);
  });

  const recover = () => recoverProject(store, { killGraceMs: GRACE_MS });

  const insertCard = async (expiresIn: string | null): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into cards (project_id, kind, question, expires_at)
       values ($1, 'ask', 'Ship it?', now() + $2::interval) returning id`,
      [store.projectId, expiresIn],
    );
    return rows[0]?.id ?? '';
  };

  const cardStatus = async (cardId: string) => {
    const { rows } = await store.db.query<{ status: string }>(
      'select status from cards where id = $1',
      [cardId],
    );
    return rows[0]?.status;
  };

  const publish = (kind: string, payload: object) =>
    store.publish({ kind, payload });

  it('does nothing on a clean project', async () => {
    expect(await recover()).toEqual({
      reaped: [],
      expiredCards: [],
      droppedPauses: [],
    });
    expect(await eventPayloads(store, PAUSE_EVENTS.dropped)).toEqual([]);
  });

  it.skipIf(IS_WINDOWS)(
    'reaps the process groups agents left behind',
    async () => {
      const left = await startSleeper({ ignoreSigterm: true });
      const reused = await startSleeper();
      const leftId = await insertAgent(store, {
        name: 'wren',
        status: 'working',
      });
      const reusedId = await insertAgent(store, { name: 'lark' });
      const goneId = await insertAgent(store, { name: 'kite' });
      await giveProcess(store, leftId, left);
      await giveProcess(store, reusedId, {
        pid: reused.pid,
        startedAt: new Date(reused.startedAt.getTime() - 3_600_000),
      });
      await giveProcess(store, goneId, {
        pid: 2 ** 22 + 777,
        startedAt: new Date(),
      });

      const { reaped } = await recover();

      expect(reaped.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        { agentId: goneId, name: 'kite', outcome: 'gone' },
        { agentId: reusedId, name: 'lark', outcome: 'gone' },
        { agentId: leftId, name: 'wren', outcome: 'killed' },
      ]);
      expect(await exitOf(left)).toEqual([null, 'SIGKILL']);
      expect(isRunning(reused.pid)).toBe(true);
      expect(
        await Promise.all(
          [leftId, reusedId, goneId].map((id) => storedPid(store, id)),
        ),
      ).toEqual([null, null, null]);
      expect(await eventPayloads(store, PROCESS_SWEPT_EVENT)).toEqual([
        { name: 'wren', pid: left.pid, reason: 'restart', outcome: 'killed' },
      ]);
      expect((await recover()).reaped).toEqual([]);
    },
  );

  it('expires overdue open cards with card.expired', async () => {
    const overdue = await insertCard('-1 minute');
    const later = await insertCard('1 hour');
    const forever = await insertCard(null);
    const answered = await insertCard('-1 hour');
    await store.db.query(
      `update cards set status = 'answered', answer = 'yes' where id = $1`,
      [answered],
    );

    const { expiredCards } = await recover();

    expect(expiredCards).toEqual([overdue]);
    expect(await cardStatus(overdue)).toBe('expired');
    expect(await cardStatus(later)).toBe('open');
    expect(await cardStatus(forever)).toBe('open');
    expect(await cardStatus(answered)).toBe('answered');
    expect(await eventPayloads(store, 'card.expired')).toEqual([
      { cardId: overdue, reason: 'restart' },
    ]);
  });

  it('drops held work the last run never replayed or dropped', async () => {
    const agentId = await insertAgent(store, { name: 'wren' });
    const ticketId = await insertTicket(store, 'open');
    const orphan = await store.publish({
      kind: PAUSE_EVENTS.held,
      agentId,
      ticketId,
      payload: {
        operation: 'launch',
        label: 'assign: QD5f',
        scopes: ['project'],
      },
    });
    const replayed = await publish(PAUSE_EVENTS.held, {
      operation: 'continue',
      label: 'continue: fix lint',
      scopes: ['agent'],
    });
    await publish('pause.replayed', {
      operation: 'continue',
      label: 'continue: fix lint',
      heldEventId: replayed.id,
    });
    const dropped = await publish(PAUSE_EVENTS.held, {
      operation: 'driver.turn',
      label: 'turn: go',
      scopes: ['global'],
    });
    await publish(PAUSE_EVENTS.dropped, {
      operation: 'driver.turn',
      label: 'turn: go',
      heldEventId: dropped.id,
      reason: 'closed',
    });

    const { droppedPauses } = await recover();

    expect(droppedPauses).toEqual([orphan.id]);
    const { rows } = await store.db.query<{
      agentId: string;
      ticketId: string;
      payload: unknown;
    }>(
      `select agent_id as "agentId", ticket_id as "ticketId", payload
       from events where kind = $1 and payload ->> 'reason' = 'restart'`,
      [PAUSE_EVENTS.dropped],
    );
    expect(rows).toEqual([
      {
        agentId,
        ticketId,
        payload: {
          operation: 'launch',
          label: 'assign: QD5f',
          heldEventId: orphan.id,
          reason: 'restart',
        },
      },
    ]);
    expect((await recover()).droppedPauses).toEqual([]);
  });
});
