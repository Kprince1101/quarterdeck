import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/store/index.js';
import { REVIEW_NOTES_MAX } from '../../src/bus/index.js';
import {
  TIMEOUT,
  callTool,
  connectClient,
  insertAgent,
  insertProject,
  insertTicket,
  openTestStore,
  ticketEvents,
  ticketRow,
} from './fixtures.ts';

const PR = 'https://github.com/legion/quarterdeck/pull/19';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

describe('bus report', () => {
  let store: Store;
  let builderId = '';
  let otherBuilderId = '';
  let reviewerId = '';
  let client: Client;

  const assigned = (status = 'assigned'): Promise<string> =>
    insertTicket(store, store.projectId, { status, assignee: builderId });

  beforeAll(async () => {
    store = await openTestStore('report');
    builderId = await insertAgent(store, store.projectId, 'okapi');
    otherBuilderId = await insertAgent(store, store.projectId, 'quokka');
    reviewerId = await insertAgent(store, store.projectId, 'heron', 'reviewer');
    client = await connectClient(store, builderId);
  }, TIMEOUT);

  afterAll(async () => {
    await client.close();
    await store.close();
  });

  beforeEach(async () => {
    await store.db.exec('delete from events; delete from tickets');
    await store.db.query(`update agents set status = 'idle' where id = $1`, [
      reviewerId,
    ]);
  });

  it('moves the ticket to in_review and hands it to the reviewer', async () => {
    const ticketId = await assigned();

    const reply = await callTool(client, 'report', {
      ticket: ticketId,
      pr: PR,
      notes: '  report and verdict, 14 tests  ',
      head: HEAD,
    });

    expect(reply).toEqual({
      text: `ticket ${ticketId} is in review; handed to heron`,
      isError: false,
    });
    expect(await ticketRow(store, ticketId)).toEqual({
      status: 'in_review',
      assignee_id: builderId,
      pr_url: PR,
      head_sha: HEAD,
    });
    expect(await ticketEvents(store)).toEqual([
      {
        agent_id: builderId,
        ticket_id: ticketId,
        kind: 'ticket.reported',
        payload: {
          pr: PR,
          head: HEAD,
          notes: 'report and verdict, 14 tests',
          reviewerId,
        },
      },
    ]);
  });

  it.each(['ended', 'killed', 'retired'])(
    'goes to in_review with no reviewer when the reviewer is %s',
    async (status) => {
      await store.db.query(`update agents set status = $2 where id = $1`, [
        reviewerId,
        status,
      ]);
      const ticketId = await assigned('in_progress');

      const reply = await callTool(client, 'report', {
        ticket: ticketId,
        pr: PR,
        notes: 'done',
      });

      expect(reply.text).toBe(
        `ticket ${ticketId} is in review; the project has no live reviewer yet, so it waits for one`,
      );
      expect((await ticketRow(store, ticketId))?.status).toBe('in_review');
      expect((await ticketEvents(store))[0]?.payload).toEqual({
        pr: PR,
        head: null,
        notes: 'done',
        reviewerId: null,
      });
    },
  );

  it.each(['bounced', 'in_review'])(
    'reports a %s ticket again, replacing the pr and clearing a head left out',
    async (status) => {
      const ticketId = await assigned(status);
      await store.db.query(
        'update tickets set pr_url = $2, head_sha = $3 where id = $1',
        [ticketId, 'https://github.com/legion/quarterdeck/pull/1', HEAD],
      );

      const reply = await callTool(client, 'report', {
        ticket: ticketId,
        pr: PR,
        notes: 'fixed what heron asked for',
      });

      expect(reply.isError).toBe(false);
      expect(await ticketRow(store, ticketId)).toMatchObject({
        status: 'in_review',
        pr_url: PR,
        head_sha: null,
      });
    },
  );

  it('refuses a ticket assigned to another agent', async () => {
    const ticketId = await insertTicket(store, store.projectId, {
      status: 'assigned',
      assignee: otherBuilderId,
    });

    const reply = await callTool(client, 'report', {
      ticket: ticketId,
      pr: PR,
      notes: 'done',
    });

    expect(reply).toEqual({
      text: `ticket ${ticketId} is not assigned to you`,
      isError: true,
    });
    expect((await ticketRow(store, ticketId))?.status).toBe('assigned');
    expect(await ticketEvents(store)).toEqual([]);
  });

  it('refuses an unassigned ticket', async () => {
    const ticketId = await insertTicket(store, store.projectId);

    const reply = await callTool(client, 'report', {
      ticket: ticketId,
      pr: PR,
      notes: 'done',
    });

    expect(reply.text).toBe(`ticket ${ticketId} is not assigned to you`);
  });

  it.each(['open', 'done', 'cancelled'])(
    'refuses a %s ticket without changing it',
    async (status) => {
      const ticketId = await assigned(status);

      const reply = await callTool(client, 'report', {
        ticket: ticketId,
        pr: PR,
        notes: 'done',
      });

      expect(reply).toEqual({
        text: `ticket ${ticketId} is ${status}; only an assigned, in_progress, in_review or bounced ticket can be reported`,
        isError: true,
      });
      expect(await ticketRow(store, ticketId)).toMatchObject({
        status,
        pr_url: null,
      });
      expect(await ticketEvents(store)).toEqual([]);
    },
  );

  it('refuses a ticket of another project', async () => {
    const otherProject = await insertProject(store, 'report-other');
    const ticketId = await insertTicket(store, otherProject, {
      status: 'assigned',
      assignee: builderId,
    });

    const reply = await callTool(client, 'report', {
      ticket: ticketId,
      pr: PR,
      notes: 'done',
    });

    expect(reply).toEqual({
      text: `no ticket ${ticketId} in this project`,
      isError: true,
    });
    expect((await ticketRow(store, ticketId))?.status).toBe('assigned');
  });

  it.each([
    ['a pr that is not a url', { pr: 'pull 19' }],
    ['a pr that is not http', { pr: 'ftp://github.com/pull/19' }],
    ['a short head', { head: 'abc123' }],
    ['an uppercase head', { head: HEAD.toUpperCase() }],
    ['blank notes', { notes: ' \n ' }],
    ['notes over the limit', { notes: 'x'.repeat(REVIEW_NOTES_MAX + 1) }],
    ['a ticket that is not an id', { ticket: 'QD4c' }],
  ])('rejects %s', async (_label, override) => {
    const ticketId = await assigned();

    const reply = await callTool(client, 'report', {
      ticket: ticketId,
      pr: PR,
      notes: 'done',
      ...override,
    });

    expect(reply.isError).toBe(true);
    expect((await ticketRow(store, ticketId))?.status).toBe('assigned');
    expect(await ticketEvents(store)).toEqual([]);
  });
});
