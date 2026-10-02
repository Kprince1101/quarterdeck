import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/store/index.js';
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

describe('bus verdict', () => {
  let store: Store;
  let builderId = '';
  let reviewerId = '';
  let builder: Client;
  let reviewer: Client;

  const inReview = async (): Promise<string> => {
    const ticketId = await insertTicket(store, store.projectId, {
      status: 'in_review',
      assignee: builderId,
    });
    await store.db.query(
      'update tickets set pr_url = $2, head_sha = $3 where id = $1',
      [ticketId, PR, HEAD],
    );
    return ticketId;
  };

  beforeAll(async () => {
    store = await openTestStore('verdict');
    builderId = await insertAgent(store, store.projectId, 'okapi');
    reviewerId = await insertAgent(store, store.projectId, 'heron', 'reviewer');
    builder = await connectClient(store, builderId);
    reviewer = await connectClient(store, reviewerId);
  }, TIMEOUT);

  afterAll(async () => {
    await builder.close();
    await reviewer.close();
    await store.close();
  });

  beforeEach(async () => {
    await store.db.exec('delete from events; delete from tickets');
    await store.db.query(`update agents set status = 'idle' where id = $1`, [
      reviewerId,
    ]);
  });

  it('approves: the ticket stays in review and the verdict is recorded', async () => {
    const ticketId = await inReview();

    const reply = await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision: 'approve',
      notes: 'Does what the ticket asks, with tests.',
    });

    expect(reply).toEqual({
      text: `approved ticket ${ticketId}; it stays in review for the merge gate`,
      isError: false,
    });
    expect((await ticketRow(store, ticketId))?.status).toBe('in_review');
    expect(await ticketEvents(store)).toEqual([
      {
        agent_id: reviewerId,
        ticket_id: ticketId,
        kind: 'ticket.verdict',
        payload: {
          decision: 'approve',
          notes: 'Does what the ticket asks, with tests.',
          pr: PR,
          head: HEAD,
        },
      },
    ]);
  });

  it('requests changes: the ticket is bounced to its builder', async () => {
    const ticketId = await inReview();

    const reply = await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision: 'changes',
      notes: 'report.ts:40 accepts a done ticket; refuse it.',
    });

    expect(reply).toEqual({
      text: `ticket ${ticketId} is bounced back to its builder`,
      isError: false,
    });
    expect(await ticketRow(store, ticketId)).toEqual({
      status: 'bounced',
      assignee_id: builderId,
      pr_url: PR,
      head_sha: HEAD,
    });
    expect((await ticketEvents(store))[0]?.payload).toMatchObject({
      decision: 'changes',
      notes: 'report.ts:40 accepts a done ticket; refuse it.',
    });
  });

  it('refuses a verdict from an agent that is not the reviewer', async () => {
    const ticketId = await inReview();

    const reply = await callTool(builder, 'verdict', {
      ticket: ticketId,
      decision: 'approve',
      notes: 'looks good to me',
    });

    expect(reply).toEqual({
      text: 'only the reviewer gives a verdict; you are the builder okapi',
      isError: true,
    });
    expect((await ticketRow(store, ticketId))?.status).toBe('in_review');
    expect(await ticketEvents(store)).toEqual([]);
  });

  it.each(['ended', 'killed', 'retired'])(
    'refuses a verdict from a %s reviewer',
    async (status) => {
      await store.db.query(`update agents set status = $2 where id = $1`, [
        reviewerId,
        status,
      ]);
      const ticketId = await inReview();

      const reply = await callTool(reviewer, 'verdict', {
        ticket: ticketId,
        decision: 'changes',
        notes: 'too late',
      });

      expect(reply).toEqual({
        text: `you are ${status} and can no longer give a verdict`,
        isError: true,
      });
      expect((await ticketRow(store, ticketId))?.status).toBe('in_review');
    },
  );

  it.each(['open', 'assigned', 'in_progress', 'bounced', 'done', 'cancelled'])(
    'refuses a verdict on a %s ticket',
    async (status) => {
      const ticketId = await insertTicket(store, store.projectId, {
        status,
        assignee: builderId,
      });

      const reply = await callTool(reviewer, 'verdict', {
        ticket: ticketId,
        decision: 'approve',
        notes: 'fine',
      });

      expect(reply).toEqual({
        text: `ticket ${ticketId} is ${status}, not in_review`,
        isError: true,
      });
      expect((await ticketRow(store, ticketId))?.status).toBe(status);
      expect(await ticketEvents(store)).toEqual([]);
    },
  );

  it('refuses a verdict on a ticket assigned to the reviewer itself', async () => {
    const ticketId = await insertTicket(store, store.projectId, {
      status: 'in_review',
      assignee: reviewerId,
    });

    const reply = await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision: 'approve',
      notes: 'mine',
    });

    expect(reply).toEqual({
      text: `ticket ${ticketId} is assigned to you; you cannot review it`,
      isError: true,
    });
  });

  it('refuses a ticket of another project', async () => {
    const otherProject = await insertProject(store, 'verdict-other');
    const ticketId = await insertTicket(store, otherProject, {
      status: 'in_review',
    });

    const reply = await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision: 'changes',
      notes: 'not mine to judge',
    });

    expect(reply).toEqual({
      text: `no ticket ${ticketId} in this project`,
      isError: true,
    });
    expect((await ticketRow(store, ticketId))?.status).toBe('in_review');
  });

  it.each([
    ['an unknown decision', { decision: 'maybe' }],
    ['blank notes', { notes: '   ' }],
  ])('rejects %s', async (_label, override) => {
    const ticketId = await inReview();

    const reply = await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision: 'approve',
      notes: 'fine',
      ...override,
    });

    expect(reply.isError).toBe(true);
    expect(await ticketEvents(store)).toEqual([]);
  });

  it('runs report, changes, report again and approve on one ticket', async () => {
    const ticketId = await insertTicket(store, store.projectId, {
      status: 'in_progress',
      assignee: builderId,
    });
    const report = (head: string) =>
      callTool(builder, 'report', {
        ticket: ticketId,
        pr: PR,
        notes: 'ready',
        head,
      });
    const fixed = 'fedcba9876543210fedcba9876543210fedcba98';

    await report(HEAD);
    await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision: 'changes',
      notes: 'missing a test',
    });
    expect((await ticketRow(store, ticketId))?.status).toBe('bounced');
    await report(fixed);
    await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision: 'approve',
      notes: 'good now',
    });

    expect(await ticketRow(store, ticketId)).toMatchObject({
      status: 'in_review',
      head_sha: fixed,
    });
    expect(
      (await ticketEvents(store)).map(({ agent_id, kind, payload }) => [
        agent_id,
        kind,
        payload['head'],
        payload['decision'],
      ]),
    ).toEqual([
      [builderId, 'ticket.reported', HEAD, undefined],
      [reviewerId, 'ticket.verdict', HEAD, 'changes'],
      [builderId, 'ticket.reported', fixed, undefined],
      [reviewerId, 'ticket.verdict', fixed, 'approve'],
    ]);
  });
});
