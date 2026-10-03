import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { forgeTerms, type MergeGate } from '@quarterdeck/rules';
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
import type { Store } from '../../src/store/index.js';
import {
  GATE_EVENTS,
  MERGE_CARD,
  parsePullRequestUrl,
  startReviewGate,
  waitingReasons,
  type ForgeHost,
  type PullRequest,
  type ReviewGate,
} from '../../src/gate/index.js';
import {
  TIMEOUT,
  callTool,
  connectClient,
  insertAgent,
  insertTicket,
  openTestStore,
  ticketEvents,
  ticketRow,
} from '../bus/fixtures.ts';

const exec = promisify(execFile);

const ORIGIN = 'git@github.com:example-org/example.git';
const PR = 'https://github.com/example-org/example/pull/1';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HOUR = 3_600_000;
const WAITING = waitingReasons(forgeTerms('github'));

const RULES: MergeGate = {
  requireReviewerApproval: true,
  requireChecksPassing: true,
  requireAiReview: false,
  aiReviewers: { github: [], gitlab: [] },
  autoMerge: false,
};

const ready = (): PullRequest => ({
  repository: { hostname: 'github.com', owner: 'example-org', name: 'example' },
  base: 'main',
  defaultBranch: 'main',
  state: 'open',
  head: HEAD,
  draft: false,
  mergeable: 'mergeable',
  checks: { state: 'passing', failing: [] },
  botReview: { reviewers: [], openThreads: [] },
});

describe('a merge answer does not bypass checks', { timeout: TIMEOUT }, () => {
  let store: Store;
  let builderId = '';
  let builder: Client;
  let reviewer: Client;
  let checkout = '';
  let pr: PullRequest;
  let merges: string[];
  let errors: unknown[];
  let gate: ReviewGate | undefined;

  const github: ForgeHost = {
    forge: 'github',
    pullRequestRef: parsePullRequestUrl,
    listOpen: async () => [],
    pullRequest: async () => pr,
    squashMerge: async (url) => {
      merges.push(url);
      pr = { ...pr, state: 'merged' };
    },
  };

  beforeAll(async () => {
    store = await openTestStore('example');
    checkout = await mkdtemp(resolve(tmpdir(), 'quarterdeck-merge-answer-'));
    await exec('git', ['init', '-q', checkout]);
    await exec('git', ['-C', checkout, 'remote', 'add', 'origin', ORIGIN]);
    await store.db.query('update projects set repo_path = $2 where id = $1', [
      store.projectId,
      checkout,
    ]);
    builderId = await insertAgent(store, store.projectId, 'builder-1');
    const reviewerId = await insertAgent(
      store,
      store.projectId,
      'reviewer-1',
      'reviewer',
    );
    await store.db.query(`update agents set status = 'working' where id = $1`, [
      reviewerId,
    ]);
    builder = await connectClient(store, builderId);
    reviewer = await connectClient(store, reviewerId);
  }, TIMEOUT);

  afterAll(async () => {
    await builder.close();
    await reviewer.close();
    await store.close();
    await rm(checkout, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await store.db.exec(
      'delete from events; delete from cards; delete from tickets',
    );
    pr = ready();
    merges = [];
    errors = [];
  });

  afterEach(async () => {
    await gate?.close();
    gate = undefined;
    expect(errors).toEqual([]);
  });

  const gateEvents = async (ticketId: string, kind: string) =>
    (await ticketEvents(store)).filter(
      (event) => event.ticket_id === ticketId && event.kind === kind,
    );

  const answerMergeWith = async (
    checks: PullRequest['checks'],
  ): Promise<string> => {
    const ticketId = await insertTicket(store, store.projectId, {
      status: 'in_progress',
      assignee: builderId,
    });
    const reported = await callTool(builder, 'report', {
      ticket: ticketId,
      pr: PR,
      head: HEAD,
      notes: 'Ready for review.',
    });
    expect(reported.isError).toBe(false);
    const approved = await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision: 'approve',
      notes: 'Reviewed the diff and the tests.',
    });
    expect(approved.isError).toBe(false);

    gate = await startReviewGate({
      store,
      rules: RULES,
      forge: github,
      reviewers: { requestReview: async () => undefined },
      pollMs: HOUR,
      onError: (err) => errors.push(err),
    });
    await gate.evaluate(ticketId);
    const { rows } = await store.db.query<{ id: string }>(
      'select id from cards where kind = $1 and ticket_id = $2',
      [MERGE_CARD, ticketId],
    );
    expect(rows).toHaveLength(1);

    pr = { ...ready(), checks };
    await store.db.query(
      `update cards set status = 'answered', answer = 'merge', answered_at = now()
       where id = $1`,
      [rows[0]?.id],
    );
    return ticketId;
  };

  it('bounces instead of merging when checks failed after the card was raised', async () => {
    const ticketId = await answerMergeWith({
      state: 'failing',
      failing: ['validate'],
    });

    await vi.waitFor(async () =>
      expect((await ticketRow(store, ticketId))?.status).toBe('bounced'),
    );
    expect(merges).toEqual([]);
    expect(
      (await gateEvents(ticketId, GATE_EVENTS.bounced))[0]?.payload['reason'],
    ).toBe('checks are failing: validate; fix them, push and report again');
  });

  it('waits instead of merging while checks are pending, then merges when they pass', async () => {
    const ticketId = await answerMergeWith({ state: 'pending', failing: [] });

    await vi.waitFor(async () =>
      expect(
        (await gateEvents(ticketId, GATE_EVENTS.waiting)).map(
          (event) => event.payload['reason'],
        ),
      ).toEqual([WAITING.checks]),
    );
    await gate?.evaluate(ticketId);
    expect(merges).toEqual([]);
    expect((await ticketRow(store, ticketId))?.status).toBe('in_review');

    pr = ready();
    await gate?.evaluate(ticketId);

    expect(merges).toEqual([PR]);
    expect((await ticketRow(store, ticketId))?.status).toBe('done');
  });
});
