import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../src/store/index.js';
import { TIMEOUT, intentRow, startTestApi, type TestApi } from './harness.js';

const project = 'board';

describe('board intents', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let store: Store;
  let repoDir = '';

  const insertCard = async (options: unknown[]) => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into cards (project_id, kind, question, options)
       values ($1, 'merge', 'Merge it?', $2::jsonb) returning id`,
      [store.projectId, JSON.stringify(options)],
    );
    return rows[0]?.id;
  };

  const cardState = async (id: unknown) => {
    const { rows } = await store.db.query<{ status: string; answer: unknown }>(
      'select status, answer from cards where id = $1',
      [id],
    );
    return rows[0];
  };

  const insertProposal = async (body: string) => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into charter_proposals (project_id, body)
       values ($1, $2) returning id`,
      [store.projectId, body],
    );
    return rows[0]?.id;
  };

  const ticketRow = async (id: unknown) => {
    const { rows } = await store.db.query<{
      title: string;
      status: string;
      depends_on: string[];
    }>('select title, status, depends_on from tickets where id = $1', [id]);
    return rows[0];
  };

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'qd-repo-'));
    t = await startTestApi();
    await t.send('project.create', { project });
    store = await t.store(project);
  }, TIMEOUT);

  afterAll(async () => {
    await t.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  describe('cards', () => {
    it('answers an open card with one of its options, once', async () => {
      const cardId = await insertCard(['merge', 'hold']);
      const wrong = await t.send('card.answer', {
        project,
        cardId,
        answer: 'yolo',
      });
      expect(wrong).toMatchObject({
        status: 400,
        body: { error: 'answer must be one of: merge, hold' },
      });
      const res = await t.send('card.answer', {
        project,
        cardId,
        answer: 'merge',
      });
      expect(res).toMatchObject({
        status: 200,
        body: { status: 'applied', result: { cardId, status: 'answered' } },
      });
      expect(await cardState(cardId)).toEqual({
        status: 'answered',
        answer: 'merge',
      });
      expect(await intentRow(store, res.body.id)).toEqual({
        kind: 'card.answer',
        status: 'applied',
        settled: true,
        events: 1,
      });
      const again = await t.send('card.decline', { project, cardId });
      expect(again.status).toBe(409);
    });

    it('takes free text when the card has no options and declines', async () => {
      const free = await insertCard([]);
      const answered = await t.send('card.answer', {
        project,
        cardId: free,
        answer: 'anything',
      });
      expect(answered.status).toBe(200);
      const declined = await insertCard(['a']);
      await t.send('card.decline', { project, cardId: declined });
      expect(await cardState(declined)).toEqual({
        status: 'declined',
        answer: null,
      });
    });

    it('answers 404 for a card in no project of ours', async () => {
      const res = await t.send('card.decline', {
        project,
        cardId: crypto.randomUUID(),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('notebook', () => {
    it('adds, pins and removes entries', async () => {
      const added = await t.send('notebook.add', {
        project,
        body: 'reviewer is strict on tests',
      });
      expect(added.status).toBe(200);
      const { entryId } = added.body.result as { entryId: string };
      const pinned = await t.send('notebook.pin', {
        project,
        entryId,
        pinned: true,
      });
      expect(pinned.body.result).toEqual({ entryId, pinned: true });
      const { rows } = await store.db.query(
        'select body, pinned from notebook',
      );
      expect(rows).toEqual([
        { body: 'reviewer is strict on tests', pinned: true },
      ]);
      expect(
        (await t.send('notebook.remove', { project, entryId })).status,
      ).toBe(200);
      expect(
        (await t.send('notebook.remove', { project, entryId })).status,
      ).toBe(404);
    });

    it('rejects an empty entry', async () => {
      const res = await t.send('notebook.add', { project, body: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('tickets', () => {
    it('creates tickets with dependencies that exist', async () => {
      const first = await t.send('ticket.create', { project, title: 'QD2a' });
      const { ticketId } = first.body.result as { ticketId: string };
      const second = await t.send('ticket.create', {
        project,
        title: 'QD6a',
        dependsOn: [ticketId],
      });
      const created = (second.body.result as { ticketId: string }).ticketId;
      expect(await ticketRow(created)).toEqual({
        title: 'QD6a',
        status: 'open',
        depends_on: [ticketId],
      });
      const dangling = await t.send('ticket.create', {
        project,
        title: 'QD6b',
        dependsOn: [crypto.randomUUID()],
      });
      expect(dangling).toMatchObject({
        status: 400,
        body: { error: 'dependsOn names a ticket that does not exist' },
      });
    });

    it('updates only the fields it is given', async () => {
      const created = await t.send('ticket.create', {
        project,
        title: 'draft',
        body: 'keep me',
      });
      const { ticketId } = created.body.result as { ticketId: string };
      expect(
        (await t.send('ticket.update', { project, ticketId })).status,
      ).toBe(400);
      expect(
        (
          await t.send('ticket.update', {
            project,
            ticketId,
            dependsOn: [ticketId],
          })
        ).body.error,
      ).toBe('a ticket cannot depend on itself');
      await t.send('ticket.update', { project, ticketId, title: 'final' });
      const { rows } = await store.db.query(
        'select title, body from tickets where id = $1',
        [ticketId],
      );
      expect(rows).toEqual([{ title: 'final', body: 'keep me' }]);
    });

    it('cancels open tickets and leaves assigned work to the Driver', async () => {
      const created = await t.send('ticket.create', { project, title: 'x' });
      const { ticketId } = created.body.result as { ticketId: string };
      await t.send('ticket.cancel', { project, ticketId });
      expect((await ticketRow(ticketId))?.status).toBe('cancelled');
      expect(
        (await t.send('ticket.update', { project, ticketId, title: 'y' }))
          .status,
      ).toBe(409);

      const { rows } = await store.db.query<{ id: string }>(
        `insert into tickets (project_id, title, status)
         values ($1, 'busy', 'in_progress') returning id`,
        [store.projectId],
      );
      const busy = await t.send('ticket.cancel', {
        project,
        ticketId: rows[0]?.id,
      });
      expect(busy.status).toBe(409);
    });
  });

  describe('charter', () => {
    it('rejects a proposal without touching files', async () => {
      const proposalId = await insertProposal('# Charter\n\nBe terse.');
      const res = await t.send('charter.decide', {
        project,
        proposalId,
        decision: 'rejected',
      });
      expect(res.body.result).toEqual({ proposalId, decision: 'rejected' });
      const again = await t.send('charter.decide', {
        project,
        proposalId,
        decision: 'accepted',
      });
      expect(again.status).toBe(409);
    });

    it('needs a repoPath to accept, then writes the project charter', async () => {
      const proposalId = await insertProposal('# Charter\n\nShip small.');
      const blocked = await t.send('charter.decide', {
        project,
        proposalId,
        decision: 'accepted',
      });
      expect(blocked).toMatchObject({
        status: 409,
        body: { error: `project ${project} has no repoPath` },
      });
      await t.send('project.update', { project, repoPath: repoDir });
      const accepted = await t.send('charter.decide', {
        project,
        proposalId,
        decision: 'accepted',
      });
      const path = join(repoDir, '.quarterdeck', 'rules.local.charter.md');
      expect(accepted.body.result).toEqual({
        proposalId,
        decision: 'accepted',
        path,
      });
      expect(await readFile(path, 'utf8')).toBe('# Charter\n\nShip small.');
    });

    it('leaves the proposal open and the charter alone when the body is refused', async () => {
      const proposalId = await insertProposal('   ');
      const refused = await t.send('charter.decide', {
        project,
        proposalId,
        decision: 'accepted',
      });
      expect(refused.status).toBe(400);
      const { rows } = await store.db.query(
        'select status from charter_proposals where id = $1',
        [proposalId],
      );
      expect(rows).toEqual([{ status: 'open' }]);
      const path = join(repoDir, '.quarterdeck', 'rules.local.charter.md');
      expect(await readFile(path, 'utf8')).toBe('# Charter\n\nShip small.');
    });
  });
});
