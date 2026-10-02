import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findApprovedTicket } from '../../src/driver/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  TICKETS_IMPORTED_EVENT,
  TicketSourceError,
  TicketSourceInputError,
  importApprovedTickets,
  localTicketSource,
  type ApprovedTicket,
  type TicketSource,
} from '../../src/tickets/index.js';

const TIMEOUT = 30_000;

interface ImportedRow {
  id: string;
  title: string;
  body: string;
  status: string;
  source: string;
  externalId: string | null;
}

const fakeSource = (
  listed: () => ApprovedTicket[] | Promise<ApprovedTicket[]>,
): TicketSource => ({
  name: 'tracker',
  listApproved: async () => listed(),
  setStatus: async () => {},
  note: async () => {},
  attachPr: async () => {},
});

describe('importing approved tickets', () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  afterEach(async () => {
    await store.db.exec('delete from events; delete from tickets;');
  });

  const rows = async (): Promise<ImportedRow[]> => {
    const result = await store.db.query<ImportedRow>(
      `select id, title, body, status, source, external_id as "externalId"
       from tickets where project_id = $1 order by created_at, external_id`,
      [store.projectId],
    );
    return result.rows;
  };

  const importedEvents = async (): Promise<unknown[]> => {
    const result = await store.db.query<{ payload: unknown }>(
      `select payload from events where project_id = $1 and kind = $2
       order by id`,
      [store.projectId, TICKETS_IMPORTED_EVENT],
    );
    return result.rows.map((row) => row.payload);
  };

  it('adds each approved ticket as an open row keyed by source and ref', async () => {
    const result = await importApprovedTickets(
      store,
      fakeSource(() => [
        { ref: 'EXT-1', title: 'Widget', body: 'Build it.' },
        { ref: 'EXT-2', title: 'Gadget', body: '' },
      ]),
    );
    const imported = await rows();
    expect(imported).toEqual([
      {
        id: expect.any(String),
        title: 'Widget',
        body: 'Build it.',
        status: 'open',
        source: 'tracker',
        externalId: 'EXT-1',
      },
      {
        id: expect.any(String),
        title: 'Gadget',
        body: '',
        status: 'open',
        source: 'tracker',
        externalId: 'EXT-2',
      },
    ]);
    const ids = imported.map((row) => row.id);
    expect(result).toEqual({ source: 'tracker', created: ids, updated: [] });
    expect(await importedEvents()).toEqual([
      { source: 'tracker', created: ids, updated: [] },
    ]);
  });

  it('gives the Driver an assignable ticket', async () => {
    const { created } = await importApprovedTickets(
      store,
      fakeSource(() => [{ ref: 'EXT-1', title: 'Widget', body: '' }]),
    );
    const [id] = created;
    expect(id).toBeDefined();
    const ticket = await findApprovedTicket(store, id ?? '');
    expect(ticket.title).toBe('Widget');
  });

  it('updates an open ticket seen again and leaves the rest alone', async () => {
    let listed: ApprovedTicket[] = [
      { ref: 'EXT-1', title: 'Widget', body: 'v1' },
      { ref: 'EXT-2', title: 'Gadget', body: 'v1' },
      { ref: 'EXT-3', title: 'Doohickey', body: 'v1' },
    ];
    const source = fakeSource(() => listed);
    const first = await importApprovedTickets(store, source);
    const [one, two, three] = first.created;
    await store.db.query(
      `update tickets set status = 'assigned' where id = $1`,
      [two],
    );
    listed = [
      { ref: 'EXT-1', title: 'Widget', body: 'v2' },
      { ref: 'EXT-2', title: 'Gadget', body: 'v2' },
      { ref: 'EXT-3', title: 'Doohickey', body: 'v1' },
      { ref: 'EXT-4', title: 'Thing', body: 'v1' },
    ];
    const second = await importApprovedTickets(store, source);
    const after = await rows();
    const four = after.find((row) => row.externalId === 'EXT-4')?.id;
    expect(second).toEqual({
      source: 'tracker',
      created: [four],
      updated: [one],
    });
    expect(after.map((row) => [row.id, row.status, row.body])).toEqual([
      [one, 'open', 'v2'],
      [two, 'assigned', 'v1'],
      [three, 'open', 'v1'],
      [four, 'open', 'v1'],
    ]);
  });

  it('records no event when nothing changed', async () => {
    const source = fakeSource(() => [{ ref: 'EXT-1', title: 'A', body: '' }]);
    await importApprovedTickets(store, source);
    const again = await importApprovedTickets(store, source);
    expect(again).toEqual({ source: 'tracker', created: [], updated: [] });
    expect(await importedEvents()).toHaveLength(1);
  });

  it('keeps the same ref from two sources apart', async () => {
    await importApprovedTickets(
      store,
      fakeSource(() => [{ ref: 'EXT-1', title: 'A', body: '' }]),
    );
    await importApprovedTickets(store, {
      ...fakeSource(() => [{ ref: 'EXT-1', title: 'B', body: '' }]),
      name: 'other',
    });
    expect((await rows()).map((row) => [row.source, row.title])).toEqual([
      ['tracker', 'A'],
      ['other', 'B'],
    ]);
  });

  it('refuses to import the tickets table into itself', async () => {
    await expect(
      importApprovedTickets(store, localTicketSource(store)),
    ).rejects.toBeInstanceOf(TicketSourceInputError);
  });

  it('writes nothing when the source fails', async () => {
    await expect(
      importApprovedTickets(
        store,
        fakeSource(() => {
          throw new TicketSourceError('tracker', 'listApproved', 'down');
        }),
      ),
    ).rejects.toBeInstanceOf(TicketSourceError);
    expect(await rows()).toEqual([]);
  });
});
