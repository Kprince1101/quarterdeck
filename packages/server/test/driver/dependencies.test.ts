import { mkdtemp, rm } from 'node:fs/promises';
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
} from 'vitest';
import {
  NO_OPEN_PROJECT,
  TICKET_PUBLISHED_EVENT,
  TICKET_UNBLOCKED_EVENT,
  TICKET_WAITING_EVENT,
  TicketNotAssignableError,
  TicketNotBlockableError,
  TicketNotPublishableError,
  blockTicket,
  findApprovedTicket,
  markUnblocked,
  markWaiting,
  readDependentTickets,
  readHeldTickets,
  recordPublished,
  storeDependencies,
  unblockHeld,
  wakePrompt,
  type DependencyResolver,
} from '../../src/driver/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';

interface Seed {
  title?: string;
  status?: string;
  assigneeId?: string | null;
  dependsOn?: string[];
}

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('dependencies across projects', () => {
  let library: Store;
  let retrofit: Store;
  let homeDir: string;
  let resolve: DependencyResolver;

  beforeAll(async () => {
    library = await openStore({ project: 'library', dataDir: IN_MEMORY });
    retrofit = await openStore({ project: 'retrofit', dataDir: IN_MEMORY });
  });

  afterAll(async () => {
    await library.close();
    await retrofit.close();
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-deps-'));
    resolve = storeDependencies(() => [library, retrofit], { homeDir });
    await library.db.query(
      'update projects set publishes = true where id = $1',
      [library.projectId],
    );
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    for (const store of [library, retrofit])
      await store.db.exec(
        `delete from events; delete from tickets; delete from agents;
         update projects set archived_at = null, publishes = null;`,
      );
  });

  const insertTicket = async (store: Store, seed: Seed = {}) => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title, status, assignee_id, depends_on)
       values ($1, $2, $3, $4, $5::uuid[]) returning id`,
      [
        store.projectId,
        seed.title ?? 'QD1 widget',
        seed.status ?? 'open',
        seed.assigneeId ?? null,
        seed.dependsOn ?? [],
      ],
    );
    return rows[0]?.id ?? '';
  };

  const insertBuilder = async (store: Store): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, 'crane', 'builder', 'idle') returning id`,
      [store.projectId],
    );
    return rows[0]?.id ?? '';
  };

  const events = async (store: Store, kind: string) => {
    const { rows } = await store.db.query<{
      ticketId: string | null;
      payload: Record<string, unknown>;
    }>(
      `select ticket_id as "ticketId", payload from events
       where kind = $1 order by id`,
      [kind],
    );
    return rows;
  };

  const status = async (store: Store, ticketId: string) => {
    const { rows } = await store.db.query<{ status: string }>(
      'select status from tickets where id = $1',
      [ticketId],
    );
    return rows[0]?.status;
  };

  it('is satisfied when done, and published when its project publishes', async () => {
    const proposed = await insertTicket(library, { status: 'proposed' });
    const merged = await insertTicket(library, { status: 'done' });
    const local = await insertTicket(retrofit, { status: 'done' });

    expect(await resolve([proposed, merged, local, UNKNOWN])).toEqual([
      expect.objectContaining({
        id: proposed,
        project: 'library',
        satisfied: false,
        reason: 'it is proposed',
      }),
      expect.objectContaining({
        id: merged,
        publishes: true,
        published: null,
        satisfied: false,
        reason: 'it is merged but not published yet',
      }),
      expect.objectContaining({
        id: local,
        project: 'retrofit',
        publishes: false,
        satisfied: true,
        reason: null,
      }),
      {
        id: UNKNOWN,
        project: null,
        title: null,
        status: null,
        publishes: false,
        published: null,
        satisfied: false,
        reason: NO_OPEN_PROJECT,
      },
    ]);

    await recordPublished(library, {
      ticketId: merged,
      package: 'acme-library',
      version: '1.4.0-SNAPSHOT',
    });
    await recordPublished(library, {
      ticketId: merged,
      package: 'acme-library',
      version: '1.4.0',
    });
    expect(await resolve([merged])).toEqual([
      expect.objectContaining({
        satisfied: true,
        published: { package: 'acme-library', version: '1.4.0' },
      }),
    ]);
  });

  it('keeps a dependency in an archived project unsatisfied, saying why', async () => {
    const merged = await insertTicket(retrofit, { status: 'done' });
    await retrofit.db.query(
      'update projects set archived_at = now() where id = $1',
      [retrofit.projectId],
    );
    expect(await resolve([merged])).toEqual([
      expect.objectContaining({
        satisfied: false,
        reason: 'its project retrofit is archived',
      }),
    ]);
  });

  it('records published only for a merged ticket', async () => {
    const open = await insertTicket(library);
    await expect(
      recordPublished(library, { ticketId: open, package: 'p', version: '1' }),
    ).rejects.toThrow(
      new TicketNotPublishableError(
        open,
        'it is open; only a merged ticket is published',
      ),
    );
    await expect(
      recordPublished(retrofit, { ticketId: open, package: 'p', version: '1' }),
    ).rejects.toBeInstanceOf(TicketNotPublishableError);
    expect(await events(library, TICKET_PUBLISHED_EVENT)).toEqual([]);
  });

  it('assigns a ticket waiting on another project only once it is satisfied', async () => {
    const blocker = await insertTicket(library, { status: 'done' });
    const waiting = await insertTicket(retrofit, { dependsOn: [blocker] });

    const refused = findApprovedTicket(retrofit, waiting, resolve);
    await expect(refused).rejects.toBeInstanceOf(TicketNotAssignableError);
    await expect(refused).rejects.toThrow(
      `it waits on ${blocker} ("QD1 widget", project library): it is merged but not published yet`,
    );
    await expect(
      findApprovedTicket(
        retrofit,
        waiting,
        storeDependencies(() => []),
      ),
    ).rejects.toThrow(`it waits on ${blocker}: ${NO_OPEN_PROJECT}`);

    await recordPublished(library, {
      ticketId: blocker,
      package: 'acme-library',
      version: '2.0.0',
    });
    expect(await findApprovedTicket(retrofit, waiting, resolve)).toMatchObject({
      id: waiting,
    });
  });

  it('blocks a held ticket on tickets in other projects and puts it back once', async () => {
    const builder = await insertBuilder(retrofit);
    const blocker = await insertTicket(library, { status: 'in_review' });
    const earlier = await insertTicket(retrofit, { status: 'done' });
    const held = await insertTicket(retrofit, {
      status: 'in_progress',
      assigneeId: builder,
      dependsOn: [earlier],
    });

    const block = await blockTicket(retrofit, resolve, {
      ticketId: held,
      on: [blocker],
      note: 'needs the new call',
    });

    expect(block.previousStatus).toBe('in_progress');
    expect(block.ticket).toMatchObject({
      status: 'blocked',
      dependsOn: [earlier, blocker],
    });
    expect(await events(retrofit, 'ticket.blocked')).toEqual([
      {
        ticketId: held,
        payload: {
          name: 'crane',
          previousStatus: 'in_progress',
          reason: 'dependencies',
          dependsOn: [blocker],
          unmet: [
            {
              ticket: blocker,
              project: 'library',
              title: 'QD1 widget',
              package: null,
              version: null,
              reason: 'it is in_review',
            },
          ],
          note: 'needs the new call',
        },
      },
    ]);
    expect(await readHeldTickets(retrofit)).toEqual([
      expect.objectContaining({ id: held, previousStatus: 'in_progress' }),
    ]);

    await library.db.query(`update tickets set status = 'done' where id = $1`, [
      blocker,
    ]);
    await recordPublished(library, {
      ticketId: blocker,
      package: 'acme-library',
      version: '1.4.0-SNAPSHOT',
    });
    const ready = await resolve([earlier, blocker]);
    const unblocked = await unblockHeld(retrofit, held, ready);
    expect(unblocked).toMatchObject({
      held: true,
      ticket: { id: held, status: 'in_progress', assigneeId: builder },
    });
    expect(await unblockHeld(retrofit, held, ready)).toBeUndefined();
    expect(await readHeldTickets(retrofit)).toEqual([]);
    expect(await events(retrofit, TICKET_UNBLOCKED_EVENT)).toEqual([
      {
        ticketId: held,
        payload: {
          held: true,
          status: 'in_progress',
          dependencies: [
            expect.objectContaining({ ticket: earlier, package: null }),
            expect.objectContaining({
              ticket: blocker,
              project: 'library',
              package: 'acme-library',
              version: '1.4.0-SNAPSHOT',
            }),
          ],
        },
      },
    ]);
    expect(wakePrompt(block.ticket, ready)).toBe(
      [
        `Ticket "QD1 widget" (ticket ${held}) is no longer blocked. Everything it waited on is ready:`,
        [
          `- ${earlier} ("QD1 widget", project retrofit): merged`,
          `- ${blocker} ("QD1 widget", project library): published acme-library 1.4.0-SNAPSHOT`,
        ].join('\n'),
        'Bump each published dependency to the version listed, then carry on with the ticket.',
      ].join('\n\n'),
    );
  });

  it('refuses to block a ticket no builder holds, on itself, or on what is already satisfied', async () => {
    const builder = await insertBuilder(retrofit);
    const blocker = await insertTicket(library);
    const done = await insertTicket(retrofit, { status: 'done' });
    const open = await insertTicket(retrofit);
    const held = await insertTicket(retrofit, {
      status: 'assigned',
      assigneeId: builder,
    });

    await expect(
      blockTicket(retrofit, resolve, { ticketId: open, on: [blocker] }),
    ).rejects.toThrow(/no builder holds it/);
    await expect(
      blockTicket(retrofit, resolve, { ticketId: held, on: [held] }),
    ).rejects.toThrow('a ticket cannot wait on itself');
    await expect(
      blockTicket(retrofit, resolve, { ticketId: held, on: [done] }),
    ).rejects.toBeInstanceOf(TicketNotBlockableError);
    await expect(
      blockTicket(library, resolve, { ticketId: held, on: [blocker] }),
    ).rejects.toThrow('it is not in this project');
    expect(await status(retrofit, held)).toBe('assigned');
    expect(await events(retrofit, 'ticket.blocked')).toEqual([]);
  });

  it('leaves a ticket a kill blocked alone', async () => {
    const builder = await insertBuilder(retrofit);
    const killed = await insertTicket(retrofit, {
      status: 'blocked',
      assigneeId: builder,
    });
    await retrofit.publish({
      kind: 'ticket.blocked',
      ticketId: killed,
      payload: { previousStatus: 'assigned', reason: 'killed' },
    });
    expect(await readHeldTickets(retrofit)).toEqual([]);
    expect(await unblockHeld(retrofit, killed, [])).toBeUndefined();
    expect(await status(retrofit, killed)).toBe('blocked');
  });

  it('marks an unassigned ticket waiting once and unblocked once', async () => {
    const blocker = await insertTicket(library);
    const waiting = await insertTicket(retrofit, { dependsOn: [blocker] });
    await insertTicket(retrofit);

    const [found] = await readDependentTickets(retrofit);
    expect(await readDependentTickets(retrofit)).toHaveLength(1);
    expect(found).toMatchObject({ id: waiting, waiting: false });

    const unmet = await resolve([blocker]);
    expect(await markUnblocked(retrofit, waiting, unmet)).toBeUndefined();
    expect(await markWaiting(retrofit, waiting, unmet)).toBe(true);
    expect(await markWaiting(retrofit, waiting, unmet)).toBe(false);
    expect((await readDependentTickets(retrofit))[0]?.waiting).toBe(true);
    expect(await events(retrofit, TICKET_WAITING_EVENT)).toEqual([
      {
        ticketId: waiting,
        payload: {
          dependsOn: [blocker],
          unmet: [
            expect.objectContaining({ ticket: blocker, reason: 'it is open' }),
          ],
        },
      },
    ]);

    await library.db.query(`update tickets set status = 'done' where id = $1`, [
      blocker,
    ]);
    await library.db.query(
      'update projects set publishes = false where id = $1',
      [library.projectId],
    );
    const ready = await resolve([blocker]);
    expect(await markUnblocked(retrofit, waiting, ready)).toMatchObject({
      held: false,
      ticket: { id: waiting },
    });
    expect(await markUnblocked(retrofit, waiting, ready)).toBeUndefined();
    expect((await readDependentTickets(retrofit))[0]?.waiting).toBe(false);
    expect(await events(retrofit, TICKET_UNBLOCKED_EVENT)).toEqual([
      {
        ticketId: waiting,
        payload: {
          held: false,
          status: 'open',
          dependencies: [expect.objectContaining({ ticket: blocker })],
        },
      },
    ]);
  });
});
