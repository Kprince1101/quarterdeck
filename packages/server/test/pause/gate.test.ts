import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import {
  MAX_LABEL_LENGTH,
  PAUSE_EVENTS,
  PauseDroppedError,
  globalPausePath,
  pauseLabel,
  pausedScopes,
  setGlobalPause,
  startPauseGate,
  type PauseGate,
  type PauseSubject,
} from '../../src/pause/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';

const TIMEOUT = 30_000;
const settle = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });

interface EventRow {
  kind: string;
  agentId: string | null;
  ticketId: string | null;
  payload: Record<string, unknown>;
}

const LAUNCH: PauseSubject = { operation: 'launch', label: 'assign: QD9' };

describe('pause gate', () => {
  let store: Store;
  let home: string;
  let gate: PauseGate;
  let errors: unknown[];

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qd-pause-'));
    errors = [];
    gate = await startPauseGate({
      store,
      home,
      onError: (err) => errors.push(err),
    });
  });

  afterEach(async () => {
    await gate.close();
    await rm(home, { recursive: true, force: true });
    await store.db.exec(
      `delete from events; delete from tickets; delete from agents;
       update projects set paused_at = null;`,
    );
    expect(errors).toEqual([]);
  });

  const pauseProject = async (paused: boolean) => {
    await store.db.query(
      `update projects set paused_at = case when $2::boolean then now() end
       where id = $1`,
      [store.projectId, paused],
    );
    await store.publish({ kind: 'pause.set' });
  };

  const insertAgent = async (status: string): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, $2, 'builder', $3) returning id`,
      [store.projectId, `crane-${crypto.randomUUID()}`, status],
    );
    return rows[0]?.id ?? '';
  };

  const events = async (): Promise<EventRow[]> => {
    const { rows } = await store.db.query<EventRow>(
      `select kind, agent_id as "agentId", ticket_id as "ticketId", payload
       from events where kind like 'pause.%' and kind not in ('pause.set', 'pause.all')
       order by id`,
    );
    return rows;
  };

  const heldCount = async (count: number) => {
    await settle(() => {
      expect(gate.held()).toHaveLength(count);
    });
  };

  it('runs work straight away when nothing is paused', async () => {
    const result = await gate.hold(LAUNCH, () => Promise.resolve('ran'));

    expect(result).toBe('ran');
    expect(await events()).toEqual([]);
  });

  it(
    'holds work while the project is paused and replays it in order on unpause',
    async () => {
      const ran: string[] = [];
      const work = (name: string) => () => {
        ran.push(name);
        return Promise.resolve(name);
      };
      await pauseProject(true);

      const first = gate.hold(LAUNCH, work('first'));
      await heldCount(1);
      const second = gate.hold(
        { operation: 'continue', label: 'continue: rebase' },
        work('second'),
      );
      await heldCount(2);
      expect(ran).toEqual([]);

      await pauseProject(false);

      expect(await first).toBe('first');
      expect(await second).toBe('second');
      expect(ran).toEqual(['first', 'second']);
      const [heldFirst, heldSecond, ...replayed] = await events();
      expect([heldFirst, heldSecond]).toEqual([
        {
          kind: PAUSE_EVENTS.held,
          agentId: null,
          ticketId: null,
          payload: {
            operation: 'launch',
            label: 'assign: QD9',
            scopes: ['project'],
          },
        },
        {
          kind: PAUSE_EVENTS.held,
          agentId: null,
          ticketId: null,
          payload: {
            operation: 'continue',
            label: 'continue: rebase',
            scopes: ['project'],
          },
        },
      ]);
      expect(replayed.map((event) => event.kind)).toEqual([
        PAUSE_EVENTS.replayed,
        PAUSE_EVENTS.replayed,
      ]);
      expect(replayed[0]?.payload).toEqual({
        operation: 'launch',
        label: 'assign: QD9',
        heldEventId: expect.any(Number),
      });
      expect(gate.held()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'holds only the paused agent and files the events under its agent and ticket',
    async () => {
      const paused = await insertAgent('paused');
      const idle = await insertAgent('idle');
      const { rows } = await store.db.query<{ id: string }>(
        `insert into tickets (project_id, title) values ($1, 'QD9') returning id`,
        [store.projectId],
      );
      const ticketId = rows[0]?.id ?? '';

      const held = gate.hold({ ...LAUNCH, agentId: paused, ticketId }, () =>
        Promise.resolve('paused agent'),
      );
      await heldCount(1);
      expect(
        await gate.hold({ ...LAUNCH, agentId: idle }, () =>
          Promise.resolve('idle agent'),
        ),
      ).toBe('idle agent');
      expect(
        await pausedScopes(store.db, store.projectId, home, paused),
      ).toEqual(['agent']);

      await pauseProject(false);
      await gate.replay();
      expect(gate.held()).toHaveLength(1);

      await store.db.query(`update agents set status = 'idle' where id = $1`, [
        paused,
      ]);
      await store.publish({ kind: 'agent.resume', agentId: paused });

      expect(await held).toBe('paused agent');
      const [first] = await events();
      expect(first).toMatchObject({
        kind: PAUSE_EVENTS.held,
        agentId: paused,
        ticketId,
        payload: { scopes: ['agent'] },
      });
    },
    TIMEOUT,
  );

  it(
    'holds everything while paused globally, until the global pause lifts',
    async () => {
      await setGlobalPause(home, true);
      await pauseProject(true);
      const pausedAt = JSON.parse(
        await readFile(globalPausePath(home), 'utf8'),
      ) as { pausedAt: string };
      expect(Number.isNaN(Date.parse(pausedAt.pausedAt))).toBe(false);

      const held = gate.hold(LAUNCH, () => Promise.resolve('ran'));
      await heldCount(1);
      expect((await events())[0]?.payload['scopes']).toEqual([
        'global',
        'project',
      ]);

      await pauseProject(false);
      await gate.replay();
      expect(gate.held()).toHaveLength(1);

      await setGlobalPause(home, false);
      expect(existsSync(globalPausePath(home))).toBe(false);
      await store.publish({ kind: 'pause.all' });

      expect(await held).toBe('ran');
    },
    TIMEOUT,
  );

  it('passes the error of replayed work to its caller', async () => {
    await pauseProject(true);
    const held = gate.hold(LAUNCH, () => Promise.reject(new Error('no repo')));
    await heldCount(1);

    await pauseProject(false);

    await expect(held).rejects.toThrow('no repo');
  });

  it('drops held work when its signal aborts', async () => {
    await pauseProject(true);
    const stop = new AbortController();
    const run = vi.fn(() => Promise.resolve('ran'));
    const held = gate.hold(LAUNCH, run, { signal: stop.signal });
    await heldCount(1);

    stop.abort();

    await expect(held).rejects.toBeInstanceOf(PauseDroppedError);
    await expect(held).rejects.toMatchObject({ reason: 'aborted' });
    await settle(async () => {
      expect((await events()).map((event) => event.kind)).toEqual([
        PAUSE_EVENTS.held,
        PAUSE_EVENTS.dropped,
      ]);
    });
    await pauseProject(false);
    await gate.replay();
    expect(run).not.toHaveBeenCalled();
    await expect(
      gate.hold(LAUNCH, run, { signal: AbortSignal.abort() }),
    ).resolves.toBe('ran');
  });

  it('refuses to hold work for a signal that has already aborted', async () => {
    await pauseProject(true);

    await expect(
      gate.hold(LAUNCH, () => Promise.resolve('ran'), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ reason: 'aborted' });
    expect(await events()).toEqual([]);
  });

  it('drops held work on close and holds nothing after', async () => {
    await pauseProject(true);
    const held = gate.hold(LAUNCH, () => Promise.resolve('ran'));
    await heldCount(1);

    await gate.close();

    await expect(held).rejects.toMatchObject({
      name: 'PauseDroppedError',
      reason: 'closed',
      message: 'Held launch "assign: QD9" was dropped: closed',
    });
    const [, dropped] = await events();
    expect(dropped).toMatchObject({
      kind: PAUSE_EVENTS.dropped,
      payload: { reason: 'closed', heldEventId: expect.any(Number) },
    });
    await expect(
      gate.hold(LAUNCH, () => Promise.resolve('ran')),
    ).rejects.toMatchObject({ reason: 'closed' });
  });
});

describe('pause labels', () => {
  it('names the operation with the first line of its text', () => {
    expect(pauseLabel('turn', '  heron reported QD12\nthe PR is open')).toBe(
      'turn: heron reported QD12',
    );
    expect(pauseLabel('message', '   ')).toBe('message');
  });

  it('shortens long text', () => {
    const label = pauseLabel('turn', 'x'.repeat(200));
    expect(label).toHaveLength(MAX_LABEL_LENGTH);
    expect(label.endsWith('…')).toBe(true);
  });
});
