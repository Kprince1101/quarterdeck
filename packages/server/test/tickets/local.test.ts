import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  LOCAL_TICKET_SOURCE,
  TICKET_NOTED_EVENT,
  TicketNotFoundError,
  TicketSourceInputError,
  localTicketSource,
  openTicketSource,
  type TicketSource,
} from '../../src/tickets/index.js';

const TIMEOUT = 30_000;
const HEAD = 'a'.repeat(40);
const MISSING = '00000000-0000-4000-8000-000000000000';

interface TicketRow {
  status: string;
  prUrl: string | null;
  headSha: string | null;
}

describe('the local ticket source', () => {
  let store: Store;
  let otherProjectId: string;
  let source: TicketSource;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
    const { rows } = await store.db.query<{ id: string }>(
      `insert into projects (slug, name) values ('other', 'other') returning id`,
    );
    otherProjectId = rows[0]?.id ?? '';
    source = localTicketSource(store);
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  afterEach(async () => {
    await store.db.exec('delete from events; delete from tickets;');
  });

  const insertTicket = async (
    title: string,
    status = 'open',
    projectId = store.projectId,
  ): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into tickets (project_id, title, body, status)
       values ($1, $2, $3, $4) returning id`,
      [projectId, title, `${title} body`, status],
    );
    return rows[0]?.id ?? '';
  };

  const ticketRow = async (id: string): Promise<TicketRow | undefined> => {
    const { rows } = await store.db.query<TicketRow>(
      `select status, pr_url as "prUrl", head_sha as "headSha"
       from tickets where id = $1`,
      [id],
    );
    return rows[0];
  };

  it('is named local and is what openTicketSource gives without a plugin', async () => {
    expect(source.name).toBe(LOCAL_TICKET_SOURCE);
    const opened = await openTicketSource(store, { project: 'deck' });
    expect(opened.name).toBe(LOCAL_TICKET_SOURCE);
  });

  it('lists the approved (open) tickets of its project in the order they were made', async () => {
    const first = await insertTicket('QD1');
    await insertTicket('QD2', 'proposed');
    const third = await insertTicket('QD3');
    await insertTicket('QD4', 'assigned');
    await insertTicket('QD5', 'open', otherProjectId);
    expect(await source.listApproved()).toEqual([
      { ref: first, title: 'QD1', body: 'QD1 body' },
      { ref: third, title: 'QD3', body: 'QD3 body' },
    ]);
  });

  it('sets a ticket status', async () => {
    const id = await insertTicket('QD1');
    await source.setStatus(id, 'done');
    expect((await ticketRow(id))?.status).toBe('done');
  });

  it('refuses a status that is not a ticket status', async () => {
    const id = await insertTicket('QD1');
    await expect(
      source.setStatus(id, 'shipped' as 'done'),
    ).rejects.toBeInstanceOf(TicketSourceInputError);
    expect((await ticketRow(id))?.status).toBe('open');
  });

  it.each([MISSING, 'not-a-uuid'])(
    'throws TicketNotFoundError for the ref %s',
    async (ref) => {
      await expect(source.setStatus(ref, 'done')).rejects.toBeInstanceOf(
        TicketNotFoundError,
      );
      await expect(source.note(ref, 'hi')).rejects.toBeInstanceOf(
        TicketNotFoundError,
      );
      await expect(
        source.attachPr(ref, { url: 'https://x.test/pr/1', head: null }),
      ).rejects.toBeInstanceOf(TicketNotFoundError);
    },
  );

  it("does not touch another project's ticket", async () => {
    const id = await insertTicket('QD1', 'open', otherProjectId);
    await expect(source.setStatus(id, 'done')).rejects.toBeInstanceOf(
      TicketNotFoundError,
    );
    await expect(source.note(id, 'hi')).rejects.toBeInstanceOf(
      TicketNotFoundError,
    );
    expect((await ticketRow(id))?.status).toBe('open');
  });

  it('records a note as a ticket.noted event', async () => {
    const id = await insertTicket('QD1');
    await source.note(id, '  CI is green.  ');
    const { rows } = await store.db.query<{
      kind: string;
      ticketId: string;
      payload: unknown;
    }>(
      `select kind, ticket_id as "ticketId", payload from events
       where project_id = $1 order by id`,
      [store.projectId],
    );
    expect(rows).toEqual([
      {
        kind: TICKET_NOTED_EVENT,
        ticketId: id,
        payload: { body: 'CI is green.' },
      },
    ]);
  });

  it('refuses an empty note', async () => {
    const id = await insertTicket('QD1');
    await expect(source.note(id, '   ')).rejects.toBeInstanceOf(
      TicketSourceInputError,
    );
  });

  it('attaches a pull request and its head', async () => {
    const id = await insertTicket('QD1', 'assigned');
    await source.attachPr(id, { url: 'https://x.test/pr/7', head: HEAD });
    expect(await ticketRow(id)).toEqual({
      status: 'assigned',
      prUrl: 'https://x.test/pr/7',
      headSha: HEAD,
    });
  });

  it.each([
    { url: 'ftp://x.test/pr/7', head: HEAD },
    { url: 'https://x.test/pr/7', head: 'abc' },
  ])('refuses the pull request %j', async (pr) => {
    const id = await insertTicket('QD1');
    await expect(source.attachPr(id, pr)).rejects.toBeInstanceOf(
      TicketSourceInputError,
    );
    expect((await ticketRow(id))?.prUrl).toBeNull();
  });
});
