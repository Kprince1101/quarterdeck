import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MergeGate } from '@quarterdeck/rules';
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
  WAITING,
  reviewPrompt,
  startReviewGate,
  type GitHubHost,
  type PullRequest,
  type ReviewGate,
  type ReviewRequest,
  type ReviewerHost,
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
  type TicketEvent,
} from '../bus/fixtures.ts';

const exec = promisify(execFile);

const ORIGIN = 'git@github.com:legion/quarterdeck.git';
const PR = 'https://github.com/legion/quarterdeck/pull/23';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const NEXT = 'fedcba9876543210fedcba9876543210fedcba98';
const HOUR = 3_600_000;

const RULES: MergeGate = {
  requireReviewerApproval: true,
  requireChecksPassing: true,
  requireCopilotReview: false,
  autoMerge: true,
};

const ready = (): PullRequest => ({
  repository: { hostname: 'github.com', owner: 'legion', name: 'quarterdeck' },
  base: 'main',
  defaultBranch: 'main',
  state: 'open',
  head: HEAD,
  draft: false,
  mergeable: 'mergeable',
  checks: { state: 'passing', failing: [] },
  copilot: { reviewed: false, openThreads: 0 },
});

interface FakeGitHub extends GitHubHost {
  pr: PullRequest;
  fetched: string[];
  merges: { url: string; head: string }[];
  mergeError: string | undefined;
}

const fakeGitHub = (): FakeGitHub => {
  const github: FakeGitHub = {
    pr: ready(),
    fetched: [],
    merges: [],
    mergeError: undefined,
    pullRequest: async (url) => {
      github.fetched.push(url);
      return github.pr;
    },
    squashMerge: async (url, head) => {
      if (github.mergeError !== undefined) throw new Error(github.mergeError);
      github.merges.push({ url, head });
      github.pr = { ...github.pr, state: 'merged' };
    },
  };
  return github;
};

interface FakeReviewers extends ReviewerHost {
  requests: ReviewRequest[];
}

const fakeReviewers = (): FakeReviewers => {
  const reviewers: FakeReviewers = {
    requests: [],
    requestReview: async (request) => {
      reviewers.requests.push(request);
    },
  };
  return reviewers;
};

const kinds = (events: TicketEvent[]): string[] =>
  events.map((event) => event.kind);

describe('review gate', () => {
  let store: Store;
  let builderId = '';
  let reviewerId = '';
  let builder: Client;
  let reviewer: Client;
  let github: FakeGitHub;
  let reviewers: FakeReviewers;
  let gate: ReviewGate | undefined;
  let errors: unknown[];
  let checkout = '';

  const start = async (rules: Partial<MergeGate> = {}): Promise<ReviewGate> => {
    gate = await startReviewGate({
      store,
      rules: { ...RULES, ...rules },
      github,
      reviewers,
      pollMs: HOUR,
      onError: (err) => errors.push(err),
    });
    await gate.sweep();
    return gate;
  };

  const assigned = (): Promise<string> =>
    insertTicket(store, store.projectId, {
      status: 'in_progress',
      assignee: builderId,
    });

  const report = async (
    ticketId: string,
    head: string | null = HEAD,
    pr = PR,
  ) => {
    const args: Record<string, unknown> = {
      ticket: ticketId,
      pr,
      notes: 'Reviewer gate and merge, with tests.',
    };
    if (head !== null) args['head'] = head;
    const reply = await callTool(builder, 'report', args);
    expect(reply.isError).toBe(false);
  };

  const verdict = async (ticketId: string, decision = 'approve') => {
    const reply = await callTool(reviewer, 'verdict', {
      ticket: ticketId,
      decision,
      notes: 'Reviewed the diff and the tests.',
    });
    expect(reply.isError).toBe(false);
  };

  const approvedTicket = async (): Promise<string> => {
    const ticketId = await assigned();
    await report(ticketId);
    await verdict(ticketId);
    return ticketId;
  };

  const status = async (ticketId: string) =>
    (await ticketRow(store, ticketId))?.status;

  const gateEvents = async (kind: string) =>
    (await ticketEvents(store)).filter((event) => event.kind === kind);

  const mergeCards = async () => {
    const { rows } = await store.db.query<{
      id: string;
      ticket_id: string;
      status: string;
      question: string;
      options: string[];
    }>(
      'select id, ticket_id, status, question, options from cards where kind = $1 order by created_at',
      [MERGE_CARD],
    );
    return rows;
  };

  beforeAll(async () => {
    store = await openTestStore('gate');
    checkout = await mkdtemp(resolve(tmpdir(), 'quarterdeck-gate-'));
    await exec('git', ['init', '-q', checkout]);
    await exec('git', ['-C', checkout, 'remote', 'add', 'origin', ORIGIN]);
    builderId = await insertAgent(store, store.projectId, 'okapi');
    reviewerId = await insertAgent(store, store.projectId, 'heron', 'reviewer');
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
    await store.db.query('update projects set repo_path = $2 where id = $1', [
      store.projectId,
      checkout,
    ]);
    await store.db.query(`update agents set status = 'working' where id = $1`, [
      reviewerId,
    ]);
    github = fakeGitHub();
    reviewers = fakeReviewers();
    errors = [];
  });

  afterEach(async () => {
    await gate?.close();
    gate = undefined;
    expect(errors).toEqual([]);
  });

  it('hands a reported ticket to the live reviewer once', async () => {
    const ticketId = await assigned();
    await report(ticketId);
    const gate = await start();

    await gate.evaluate(ticketId);
    await gate.evaluate(ticketId);

    expect(reviewers.requests).toEqual([
      {
        ticket: {
          id: ticketId,
          title: 'QD4c report + verdict',
          body: '',
        },
        reviewer: { id: reviewerId, name: 'heron' },
        builder: { id: builderId, name: 'okapi' },
        pr: PR,
        head: HEAD,
        notes: 'Reviewer gate and merge, with tests.',
      },
    ]);
    expect(await gateEvents(GATE_EVENTS.reviewRequested)).toEqual([
      {
        agent_id: reviewerId,
        ticket_id: ticketId,
        kind: GATE_EVENTS.reviewRequested,
        payload: { reviewerId, pr: PR, head: HEAD },
      },
    ]);
  });

  it('hands a report to the reviewer as it arrives', async () => {
    await start();
    const ticketId = await assigned();

    await report(ticketId);

    await vi.waitFor(() => expect(reviewers.requests).toHaveLength(1));
    expect(reviewers.requests[0]?.ticket.id).toBe(ticketId);
  });

  it('waits for a reviewer, then hands the report to one that comes up', async () => {
    await store.db.query(`update agents set status = 'retired' where id = $1`, [
      reviewerId,
    ]);
    const ticketId = await assigned();
    await report(ticketId);
    const gate = await start();

    await gate.evaluate(ticketId);
    await gate.evaluate(ticketId);

    expect(reviewers.requests).toEqual([]);
    expect(await gateEvents(GATE_EVENTS.waiting)).toEqual([
      expect.objectContaining({
        payload: { reason: WAITING.reviewer, pr: PR, head: HEAD },
      }),
    ]);

    await store.db.query(`update agents set status = 'idle' where id = $1`, [
      reviewerId,
    ]);

    await vi.waitFor(() => expect(reviewers.requests).toHaveLength(1));
  });

  it('retries a review the reviewer host could not deliver', async () => {
    const ticketId = await assigned();
    await report(ticketId);
    const deliver = reviewers.requestReview;
    reviewers.requestReview = async () => {
      throw new Error('session not ready');
    };
    const gate = await start();

    expect(errors).toEqual([
      expect.objectContaining({
        message: `review gate failed on ticket ${ticketId}: session not ready`,
      }),
    ]);
    await expect(gate.evaluate(ticketId)).rejects.toThrow('session not ready');
    expect(await gateEvents(GATE_EVENTS.reviewRequested)).toEqual([]);

    reviewers.requestReview = deliver;
    await gate.evaluate(ticketId);
    expect(reviewers.requests).toHaveLength(1);
    errors = [];
  });

  it('squash merges an approval at the approved head and completes the ticket', async () => {
    await start();
    const ticketId = await assigned();
    await report(ticketId);
    await vi.waitFor(() => expect(reviewers.requests).toHaveLength(1));
    await vi.waitFor(async () =>
      expect(await gateEvents(GATE_EVENTS.reviewRequested)).toHaveLength(1),
    );

    await verdict(ticketId);

    await vi.waitFor(async () => expect(await status(ticketId)).toBe('done'));

    expect(github.merges).toEqual([{ url: PR, head: HEAD }]);
    expect(kinds(await ticketEvents(store))).toEqual([
      GATE_EVENTS.reported,
      GATE_EVENTS.reviewRequested,
      GATE_EVENTS.verdict,
      GATE_EVENTS.merged,
    ]);
    expect(await gateEvents(GATE_EVENTS.merged)).toEqual([
      {
        agent_id: null,
        ticket_id: ticketId,
        kind: GATE_EVENTS.merged,
        payload: { pr: PR, head: HEAD, by: 'gate' },
      },
    ]);
  });

  it('with auto merge off, raises a merge card and merges on a merge answer', async () => {
    const ticketId = await approvedTicket();
    const gate = await start({ autoMerge: false });

    await gate.evaluate(ticketId);
    await gate.evaluate(ticketId);

    const cards = await mergeCards();
    expect(cards).toEqual([
      expect.objectContaining({
        ticket_id: ticketId,
        status: 'open',
        options: ['merge', 'hold'],
      }),
    ]);
    expect(cards[0]?.question).toContain(`Merge ${PR}`);
    expect(github.merges).toEqual([]);
    expect(await status(ticketId)).toBe('in_review');

    await store.db.query(
      `update cards set status = 'answered', answer = 'merge', answered_at = now()
       where id = $1`,
      [cards[0]?.id],
    );

    await vi.waitFor(async () => expect(await status(ticketId)).toBe('done'));
    expect(github.merges).toEqual([{ url: PR, head: HEAD }]);
  });

  it('holds on a hold answer and completes when a human merges on GitHub', async () => {
    const ticketId = await approvedTicket();
    const gate = await start({ autoMerge: false });
    await gate.evaluate(ticketId);
    const [card] = await mergeCards();
    await store.db.query(
      `update cards set status = 'answered', answer = 'hold', answered_at = now()
       where id = $1`,
      [card?.id],
    );

    await vi.waitFor(async () =>
      expect((await gateEvents(GATE_EVENTS.waiting)).at(-1)?.payload).toEqual({
        reason: WAITING.held,
        pr: PR,
        head: HEAD,
      }),
    );
    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([]);
    expect(await status(ticketId)).toBe('in_review');
    expect(
      (await gateEvents(GATE_EVENTS.waiting)).map(
        (event) => event.payload['reason'],
      ),
    ).toEqual([WAITING.human, WAITING.held]);

    github.pr = { ...github.pr, state: 'merged' };
    await gate.sweep();

    expect(await status(ticketId)).toBe('done');
    expect((await gateEvents(GATE_EVENTS.merged))[0]?.payload).toEqual({
      pr: PR,
      head: HEAD,
      by: 'github',
    });
  });

  it('waits for pending checks once, then merges when they pass', async () => {
    github.pr = { ...ready(), checks: { state: 'pending', failing: [] } };
    const ticketId = await approvedTicket();
    const gate = await start();

    await gate.evaluate(ticketId);
    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([]);
    expect(await gateEvents(GATE_EVENTS.waiting)).toHaveLength(1);

    github.pr = ready();
    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([{ url: PR, head: HEAD }]);
    expect(await status(ticketId)).toBe('done');
  });

  it('bounces failing checks back to the builder', async () => {
    github.pr = {
      ...ready(),
      checks: { state: 'failing', failing: ['validate'] },
    };
    const ticketId = await approvedTicket();
    const gate = await start();

    await gate.evaluate(ticketId);

    expect(await status(ticketId)).toBe('bounced');
    expect(github.merges).toEqual([]);
    expect(await gateEvents(GATE_EVENTS.bounced)).toEqual([
      {
        agent_id: null,
        ticket_id: ticketId,
        kind: GATE_EVENTS.bounced,
        payload: {
          reason:
            'checks are failing: validate; fix them, push and report again',
          pr: PR,
          head: HEAD,
        },
      },
    ]);
  });

  it('bounces when the pull request head moved after the approval', async () => {
    github.pr = { ...ready(), head: NEXT };
    const ticketId = await approvedTicket();
    const gate = await start();

    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([]);
    expect(await status(ticketId)).toBe('bounced');
  });

  it('gates on Copilot when asked: waits for it, bounces open threads', async () => {
    const ticketId = await approvedTicket();
    const gate = await start({ requireCopilotReview: true });

    await gate.evaluate(ticketId);
    expect((await gateEvents(GATE_EVENTS.waiting))[0]?.payload).toMatchObject({
      reason: WAITING.copilot,
    });

    github.pr = { ...ready(), copilot: { reviewed: true, openThreads: 1 } };
    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([]);
    expect(await status(ticketId)).toBe('bounced');
  });

  it('merges once Copilot has reviewed and its threads are resolved', async () => {
    github.pr = { ...ready(), copilot: { reviewed: true, openThreads: 0 } };
    const ticketId = await approvedTicket();
    const gate = await start({ requireCopilotReview: true });

    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([{ url: PR, head: HEAD }]);
  });

  it('a report after the approval withdraws it and asks for a new review', async () => {
    const ticketId = await approvedTicket();
    await report(ticketId, NEXT);
    github.pr = { ...ready(), head: NEXT };
    const gate = await start();

    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([]);
    expect(await status(ticketId)).toBe('in_review');
    expect(reviewers.requests.map((request) => request.head)).toEqual([NEXT]);
  });

  it('raises a merge card naming the error when the merge fails', async () => {
    github.mergeError = 'gh pr merge failed: base branch policy prohibits';
    const ticketId = await approvedTicket();
    const gate = await start();

    await gate.evaluate(ticketId);
    await gate.evaluate(ticketId);

    const cards = await mergeCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.question).toContain('base branch policy prohibits');
    expect(await status(ticketId)).toBe('in_review');
    expect((await gateEvents(GATE_EVENTS.mergeRequested))[0]?.payload).toEqual({
      cardId: cards[0]?.id,
      pr: PR,
      head: HEAD,
      error: 'gh pr merge failed: base branch policy prohibits',
    });
  });

  it('merges nothing after a changes verdict', async () => {
    const ticketId = await assigned();
    await report(ticketId);
    await verdict(ticketId, 'changes');
    const gate = await start();

    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([]);
    expect(await mergeCards()).toEqual([]);
    expect(await status(ticketId)).toBe('bounced');
  });

  it('merges on the report alone when reviewer approval is off', async () => {
    const ticketId = await assigned();
    await report(ticketId);
    const gate = await start({ requireReviewerApproval: false });

    await gate.evaluate(ticketId);

    expect(reviewers.requests).toEqual([]);
    expect(github.merges).toEqual([{ url: PR, head: HEAD }]);
    expect(await status(ticketId)).toBe('done');
  });

  it('bounces an approval of a report that gave no head', async () => {
    const ticketId = await assigned();
    await report(ticketId, null);
    await verdict(ticketId);
    const gate = await start();

    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([]);
    expect(await status(ticketId)).toBe('bounced');
  });

  it('catches up on tickets in review when it starts', async () => {
    const ticketId = await approvedTicket();

    await start();

    await vi.waitFor(async () => expect(await status(ticketId)).toBe('done'));
  });

  it('reports a GitHub failure and leaves the ticket in review', async () => {
    const ticketId = await approvedTicket();
    github.pullRequest = async () => {
      throw new Error('gh api graphql failed: not signed in');
    };
    const gate = await start();

    expect(errors).toHaveLength(1);
    await expect(gate.evaluate(ticketId)).rejects.toThrow(
      `review gate failed on ticket ${ticketId}: gh api graphql failed: not signed in`,
    );
    expect(await status(ticketId)).toBe('in_review');
    errors = [];
  });

  it('bounces a pull request in another repository without fetching or merging it', async () => {
    const foreign = 'https://github.com/mallory/payroll/pull/9';
    const ticketId = await assigned();
    await report(ticketId, HEAD, foreign);
    await verdict(ticketId);
    const gate = await start({ autoMerge: true });

    await gate.evaluate(ticketId);

    expect(github.fetched).toEqual([]);
    expect(github.merges).toEqual([]);
    expect(await mergeCards()).toEqual([]);
    expect(await status(ticketId)).toBe('bounced');
    expect((await gateEvents(GATE_EVENTS.bounced))[0]?.payload).toEqual({
      reason: `the pull request ${foreign} is not in this project's repository github.com/legion/quarterdeck; open it there and report again`,
      pr: foreign,
      head: HEAD,
    });
  });

  it('bounces a pull request into a branch other than the default', async () => {
    github.pr = { ...ready(), base: 'release/1.0' };
    const ticketId = await approvedTicket();
    const gate = await start();

    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([]);
    expect(await status(ticketId)).toBe('bounced');
    expect((await gateEvents(GATE_EVENTS.bounced))[0]?.payload).toMatchObject({
      reason:
        'the pull request merges into release/1.0, not main; retarget it to main and report again',
    });
  });

  it('merges into a configured base instead of the default branch', async () => {
    github.pr = { ...ready(), base: 'trunk' };
    const ticketId = await approvedTicket();
    const gate = await start({ base: 'trunk' });

    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([{ url: PR, head: HEAD }]);
  });

  it('touches GitHub for nothing while the project repository is unknown', async () => {
    await store.db.query('update projects set repo_path = null where id = $1', [
      store.projectId,
    ]);
    const ticketId = await approvedTicket();
    const gate = await start();

    expect(errors).toHaveLength(1);
    await expect(gate.evaluate(ticketId)).rejects.toThrow(
      'the project has no repo_path',
    );
    expect(github.fetched).toEqual([]);
    expect(github.merges).toEqual([]);
    expect(await status(ticketId)).toBe('in_review');

    await store.db.query('update projects set repo_path = $2 where id = $1', [
      store.projectId,
      checkout,
    ]);
    await gate.evaluate(ticketId);

    expect(github.merges).toEqual([{ url: PR, head: HEAD }]);
    errors = [];
  });
});

describe('review prompt', () => {
  it('names the ticket, pull request, head and notes', () => {
    const prompt = reviewPrompt({
      ticket: { id: 't1', title: 'QD5e reviewer gate', body: 'Gate it.' },
      reviewer: { id: 'r1', name: 'heron' },
      builder: { id: 'b1', name: 'okapi' },
      pr: PR,
      head: null,
      notes: 'All tests pass.',
    });

    expect(prompt).toBe(
      [
        'Review ticket t1: QD5e reviewer gate',
        '',
        'Gate it.',
        '',
        `Pull request: ${PR}`,
        'Head commit: not reported',
        '',
        'Notes from okapi:',
        'All tests pass.',
        '',
        'Give your verdict on ticket t1 with the bus tool `verdict`.',
      ].join('\n'),
    );
  });
});
