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

    it('adds an entry for every project, which pins and removes the same way', async () => {
      const added = await t.send('notebook.add', {
        project,
        body: 'every repo ships with tests',
        global: true,
      });
      const { entryId } = added.body.result as { entryId: string };
      expect(added.body.result).toEqual({ entryId, global: true });
      const projectOf = async () => {
        const { rows } = await store.db.query<{ projectId: string | null }>(
          'select project_id as "projectId" from notebook where id = $1',
          [entryId],
        );
        return rows[0]?.projectId;
      };
      expect(await projectOf()).toBeNull();
      expect(
        (await t.send('notebook.pin', { project, entryId, pinned: true }))
          .status,
      ).toBe(200);
      expect(
        (await t.send('notebook.remove', { project, entryId })).status,
      ).toBe(200);
      expect(await projectOf()).toBeUndefined();
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

    it('creates a ticket that depends on a ticket in another open project', async () => {
      await t.send('project.create', { project: 'library' });
      const library = await t.send('ticket.create', {
        project: 'library',
        title: 'Add the call',
      });
      const { ticketId } = library.body.result as { ticketId: string };
      const created = await t.send('ticket.create', {
        project,
        title: 'Use the call',
        dependsOn: [ticketId],
      });
      expect(created.status).toBe(200);
      const id = (created.body.result as { ticketId: string }).ticketId;
      expect(await ticketRow(id)).toEqual({
        title: 'Use the call',
        status: 'open',
        depends_on: [ticketId],
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

    const insertProposed = async (title: string, dependsOn: string[] = []) => {
      const { rows } = await store.db.query<{ id: string }>(
        `insert into tickets (project_id, title, depends_on, status)
         values ($1, $2, $3::uuid[], 'proposed') returning id`,
        [store.projectId, title, dependsOn],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('proposal not stored');
      return id;
    };

    it('approves a proposal, with the edits the human made', async () => {
      const ticketId = await insertProposed('draft');
      const res = await t.send('ticket.approve', {
        project,
        ticketId,
        title: 'QD5b Planner',
      });
      expect(res).toMatchObject({
        status: 200,
        body: { result: { ticketId, status: 'open' } },
      });
      expect(await ticketRow(ticketId)).toEqual({
        title: 'QD5b Planner',
        status: 'open',
        depends_on: [],
      });
      expect(await intentRow(store, res.body.id)).toMatchObject({
        kind: 'ticket.approve',
        status: 'applied',
      });
      const again = await t.send('ticket.approve', { project, ticketId });
      expect(again).toMatchObject({
        status: 409,
        body: { error: `ticket ${ticketId} is open, not proposed` },
      });
    });

    it('edits a proposal in place and keeps it proposed', async () => {
      const ticketId = await insertProposed('draft');
      await t.send('ticket.update', { project, ticketId, body: 'tests first' });
      const { rows } = await store.db.query(
        'select body, status from tickets where id = $1',
        [ticketId],
      );
      expect(rows).toEqual([{ body: 'tests first', status: 'proposed' }]);
    });

    it('holds approval until every dependency is approved', async () => {
      const first = await insertProposed('store');
      const second = await insertProposed('api', [first]);
      const blocked = await t.send('ticket.approve', {
        project,
        ticketId: second,
      });
      expect(blocked).toMatchObject({
        status: 409,
        body: {
          error: `ticket ${second} depends on tickets that are not approved: ${first} (proposed)`,
        },
      });
      expect((await ticketRow(second))?.status).toBe('proposed');
      await t.send('ticket.approve', { project, ticketId: first });
      const approved = await t.send('ticket.approve', {
        project,
        ticketId: second,
      });
      expect(approved.status).toBe(200);
    });

    it('lets an approval drop a rejected dependency', async () => {
      const first = await insertProposed('spike');
      const second = await insertProposed('build', [first]);
      await t.send('ticket.reject', { project, ticketId: first });
      const blocked = await t.send('ticket.approve', {
        project,
        ticketId: second,
      });
      expect(blocked.body.error).toBe(
        `ticket ${second} depends on tickets that are not approved: ${first} (rejected)`,
      );
      const approved = await t.send('ticket.approve', {
        project,
        ticketId: second,
        dependsOn: [],
      });
      expect(approved.status).toBe(200);
      expect(await ticketRow(second)).toMatchObject({
        status: 'open',
        depends_on: [],
      });
    });

    it('rejects a proposal and then refuses to change it', async () => {
      const ticketId = await insertProposed('not now');
      const res = await t.send('ticket.reject', { project, ticketId });
      expect(res).toMatchObject({
        status: 200,
        body: { result: { ticketId, status: 'rejected' } },
      });
      expect((await ticketRow(ticketId))?.status).toBe('rejected');
      expect(
        (await t.send('ticket.update', { project, ticketId, title: 'y' }))
          .status,
      ).toBe(409);
      expect(
        (await t.send('ticket.approve', { project, ticketId })).status,
      ).toBe(409);
      expect(
        (await t.send('ticket.reject', { project, ticketId })).status,
      ).toBe(409);
    });

    it('only approves or rejects proposals', async () => {
      const created = await t.send('ticket.create', { project, title: 'open' });
      const { ticketId } = created.body.result as { ticketId: string };
      expect(
        (await t.send('ticket.reject', { project, ticketId })).body,
      ).toEqual({
        error: `ticket ${ticketId} is open, not proposed`,
      });
      const missing = await t.send('ticket.approve', {
        project,
        ticketId: crypto.randomUUID(),
      });
      expect(missing.status).toBe(404);
    });
  });

  describe('notebook proposals', () => {
    const addEntry = async (body: string) => {
      const res = await t.send('notebook.add', { project, body });
      return (res.body.result as { entryId: string }).entryId;
    };

    const propose = async (
      op: string,
      entryId: string | null,
      body: string | null,
    ) => {
      const { rows } = await store.db.query<{ id: string }>(
        `insert into notebook_proposals (project_id, op, entry_id, body)
         values ($1, $2, $3, $4) returning id`,
        [store.projectId, op, entryId, body],
      );
      return rows[0]?.id ?? '';
    };

    const entry = async (id: unknown) => {
      const { rows } = await store.db.query<{
        body: string;
        retired: boolean;
      }>(
        `select body, retired_at is not null as retired
         from notebook where id = $1`,
        [id],
      );
      return rows[0];
    };

    const proposal = async (id: string) => {
      const { rows } = await store.db.query<{
        status: string;
        body: string | null;
        decided: boolean;
      }>(
        `select status, body, decided_at is not null as decided
         from notebook_proposals where id = $1`,
        [id],
      );
      return rows[0];
    };

    const decide = (proposalId: string, decision: string, body?: string) =>
      t.send('notebook.decide', { project, proposalId, decision, body });

    it('accepts an add as a new entry, with the edit the human made', async () => {
      const proposalId = await propose('add', null, 'Run both backends.');
      const res = await decide(
        proposalId,
        'accepted',
        'Run both store backends.',
      );
      expect(res.status).toBe(200);
      const result = res.body.result as { entryId: string };
      expect(result).toEqual({
        proposalId,
        decision: 'accepted',
        op: 'add',
        entryId: result.entryId,
      });
      expect(await entry(result.entryId)).toEqual({
        body: 'Run both store backends.',
        retired: false,
      });
      expect(await proposal(proposalId)).toEqual({
        status: 'accepted',
        body: 'Run both store backends.',
        decided: true,
      });
      expect(await intentRow(store, res.body.id)).toMatchObject({
        kind: 'notebook.decide',
        status: 'applied',
      });
    });

    it('accepts a global add as an entry for every project', async () => {
      const { rows } = await store.db.query<{ id: string }>(
        `insert into notebook_proposals (project_id, op, body, global)
         values ($1, 'add', 'Run both suites.', true) returning id`,
        [store.projectId],
      );
      const res = await decide(rows[0]?.id ?? '', 'accepted');
      const { entryId } = res.body.result as { entryId: string };
      const { rows: entries } = await store.db.query<{
        projectId: string | null;
      }>('select project_id as "projectId" from notebook where id = $1', [
        entryId,
      ]);
      expect(entries).toEqual([{ projectId: null }]);
    });

    it('accepts an update and a retire against the entry', async () => {
      const entryId = await addEntry('Tests matter.');
      const update = await propose(
        'update',
        entryId,
        'Every ticket has tests.',
      );
      await decide(update, 'accepted');
      expect(await entry(entryId)).toEqual({
        body: 'Every ticket has tests.',
        retired: false,
      });

      const retire = await propose('retire', entryId, null);
      expect((await decide(retire, 'accepted', 'x')).status).toBe(400);
      expect((await decide(retire, 'accepted')).status).toBe(200);
      expect(await entry(entryId)).toEqual({
        body: 'Every ticket has tests.',
        retired: true,
      });

      const late = await propose('update', entryId, 'Too late.');
      expect(await decide(late, 'accepted')).toMatchObject({
        status: 409,
        body: { error: `notebook entry ${entryId} is retired` },
      });
      expect((await proposal(late))?.status).toBe('open');
    });

    it('rejects without touching the notebook, once', async () => {
      const entryId = await addEntry('Keep me.');
      const proposalId = await propose('retire', entryId, null);
      expect((await decide(proposalId, 'rejected')).body.result).toEqual({
        proposalId,
        decision: 'rejected',
        op: 'retire',
      });
      expect(await entry(entryId)).toEqual({
        body: 'Keep me.',
        retired: false,
      });
      expect(await decide(proposalId, 'accepted')).toMatchObject({
        status: 409,
        body: { error: `notebook proposal ${proposalId} is already rejected` },
      });
      expect((await decide(crypto.randomUUID(), 'accepted')).status).toBe(404);
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
