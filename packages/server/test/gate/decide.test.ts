import type { MergeGate } from '@quarterdeck/rules';
import { describe, expect, it } from 'vitest';
import {
  WAITING,
  foreignPullRequest,
  mergeStep as decideMerge,
  reviewStep,
  type Approval,
  type MergeCardState,
  type PullRequest,
  type RepositoryRef,
} from '../../src/gate/index.js';
import type { TicketFacts } from '../../src/gate/facts.js';

const PROJECT: RepositoryRef = {
  hostname: 'github.com',
  owner: 'legion',
  name: 'quarterdeck',
};

const PR = 'https://github.com/legion/quarterdeck/pull/23';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

const RULES: MergeGate = {
  requireReviewerApproval: true,
  requireChecksPassing: true,
  requireCopilotReview: false,
  autoMerge: true,
};

const facts = (extra: Partial<TicketFacts> = {}): TicketFacts => ({
  ticket: {
    id: 't1',
    title: 'QD5e',
    body: '',
    status: 'in_review',
    assigneeId: 'b1',
  },
  report: { eventId: 10, pr: PR, head: HEAD, notes: 'n', reviewerId: 'r1' },
  verdict: undefined,
  reviewRequested: false,
  waitingFor: undefined,
  mergeCards: [],
  ...extra,
});

const approved = {
  eventId: 12,
  decision: 'approve',
  pr: PR,
  head: HEAD,
} as const;

const APPROVAL: Approval = {
  eventId: 12,
  reportId: 10,
  pr: PR,
  head: HEAD,
  cardId: undefined,
};

const mergeStep = (
  approval: Approval,
  pr: PullRequest,
  card: MergeCardState,
  rules: MergeGate,
) => decideMerge(approval, pr, card, rules, PROJECT);

const pull = (extra: Partial<PullRequest> = {}): PullRequest => ({
  repository: PROJECT,
  base: 'main',
  defaultBranch: 'main',
  state: 'open',
  head: HEAD,
  draft: false,
  mergeable: 'mergeable',
  checks: { state: 'passing', failing: [] },
  copilot: { reviewed: false, openThreads: 0 },
  ...extra,
});

describe('review step', () => {
  it('asks for a review once per report', () => {
    expect(reviewStep(facts(), RULES)).toEqual({ kind: 'review' });
    expect(reviewStep(facts({ reviewRequested: true }), RULES)).toEqual({
      kind: 'idle',
    });
  });

  it('does nothing for a ticket that is not in review or never reported', () => {
    const bounced = facts({
      ticket: { ...facts().ticket, status: 'bounced' },
    });
    expect(reviewStep(bounced, RULES)).toEqual({ kind: 'idle' });
    expect(reviewStep(facts({ report: undefined }), RULES)).toEqual({
      kind: 'idle',
    });
  });

  it('does nothing after a changes verdict', () => {
    const changes = { ...approved, decision: 'changes' } as const;
    expect(reviewStep(facts({ verdict: changes }), RULES)).toEqual({
      kind: 'idle',
    });
  });

  it('hands an approval to the merge gate at the head the verdict saw', () => {
    expect(reviewStep(facts({ verdict: approved }), RULES)).toEqual({
      kind: 'merge-gate',
      approval: APPROVAL,
    });
  });

  it('picks the merge card raised after the approval', () => {
    const step = reviewStep(
      facts({
        verdict: approved,
        mergeCards: [
          { eventId: 13, cardId: 'c1' },
          { eventId: 15, cardId: 'c2' },
        ],
      }),
      RULES,
    );
    expect(step).toEqual({
      kind: 'merge-gate',
      approval: { ...APPROVAL, cardId: 'c2' },
    });
  });

  it('bounces an approval with no head commit', () => {
    const step = reviewStep(
      facts({ verdict: { ...approved, head: null } }),
      RULES,
    );
    expect(step).toMatchObject({ kind: 'bounce' });
  });

  it('takes the report as the approval when reviewer approval is off', () => {
    const step = reviewStep(facts(), {
      ...RULES,
      requireReviewerApproval: false,
    });
    expect(step).toEqual({
      kind: 'merge-gate',
      approval: { ...APPROVAL, eventId: 10 },
    });
  });
});

describe('merge step', () => {
  it('merges a ready pull request when auto merge is on', () => {
    expect(mergeStep(APPROVAL, pull(), 'none', RULES)).toEqual({
      kind: 'merge',
    });
  });

  it('asks a human when auto merge is off, then waits on the card', () => {
    const manual = { ...RULES, autoMerge: false };
    expect(mergeStep(APPROVAL, pull(), 'none', manual)).toEqual({
      kind: 'ask',
    });
    expect(mergeStep(APPROVAL, pull(), 'open', manual)).toEqual({
      kind: 'wait',
      reason: WAITING.human,
    });
    expect(mergeStep(APPROVAL, pull(), 'merge', manual)).toEqual({
      kind: 'merge',
    });
    expect(mergeStep(APPROVAL, pull(), 'held', manual)).toEqual({
      kind: 'wait',
      reason: WAITING.held,
    });
  });

  it('waits on an open card even with auto merge on', () => {
    expect(mergeStep(APPROVAL, pull(), 'open', RULES)).toEqual({
      kind: 'wait',
      reason: WAITING.human,
    });
  });

  it('completes a pull request merged on GitHub, even when held', () => {
    const merged = pull({ state: 'merged', head: OTHER });
    expect(mergeStep(APPROVAL, merged, 'held', RULES)).toEqual({
      kind: 'merged',
    });
  });

  it('bounces a closed pull request and a moved head', () => {
    expect(
      mergeStep(APPROVAL, pull({ state: 'closed' }), 'none', RULES),
    ).toMatchObject({
      kind: 'bounce',
      reason: expect.stringContaining('closed'),
    });
    expect(mergeStep(APPROVAL, pull({ head: OTHER }), 'none', RULES)).toEqual({
      kind: 'bounce',
      reason: `the pull request head is ${OTHER}, not the approved ${HEAD}; report the new head for review`,
    });
  });

  it('waits on a draft, pending checks and unknown mergeability', () => {
    expect(mergeStep(APPROVAL, pull({ draft: true }), 'none', RULES)).toEqual({
      kind: 'wait',
      reason: WAITING.draft,
    });
    const pending = pull({ checks: { state: 'pending', failing: [] } });
    expect(mergeStep(APPROVAL, pending, 'none', RULES)).toEqual({
      kind: 'wait',
      reason: WAITING.checks,
    });
    expect(
      mergeStep(APPROVAL, pull({ mergeable: 'unknown' }), 'none', RULES),
    ).toEqual({ kind: 'wait', reason: WAITING.mergeable });
  });

  it('bounces failing checks, naming them, and conflicts', () => {
    const failing = pull({
      checks: { state: 'failing', failing: ['validate', 'lint'] },
    });
    expect(mergeStep(APPROVAL, failing, 'none', RULES)).toEqual({
      kind: 'bounce',
      reason:
        'checks are failing: validate, lint; fix them, push and report again',
    });
    expect(
      mergeStep(APPROVAL, pull({ mergeable: 'conflicting' }), 'none', RULES),
    ).toMatchObject({
      kind: 'bounce',
      reason: expect.stringContaining('rebase'),
    });
  });

  it('ignores checks when they are not required', () => {
    const failing = pull({ checks: { state: 'failing', failing: ['x'] } });
    expect(
      mergeStep(APPROVAL, failing, 'none', {
        ...RULES,
        requireChecksPassing: false,
      }),
    ).toEqual({ kind: 'merge' });
  });

  it('merges with no checks configured at all', () => {
    const none = pull({ checks: { state: 'none', failing: [] } });
    expect(mergeStep(APPROVAL, none, 'none', RULES)).toEqual({ kind: 'merge' });
  });

  it('gates on Copilot only when asked to', () => {
    const copilot = { ...RULES, requireCopilotReview: true };
    expect(mergeStep(APPROVAL, pull(), 'none', copilot)).toEqual({
      kind: 'wait',
      reason: WAITING.copilot,
    });
    const threads = pull({ copilot: { reviewed: true, openThreads: 2 } });
    expect(mergeStep(APPROVAL, threads, 'none', copilot)).toMatchObject({
      kind: 'bounce',
      reason: expect.stringContaining('2 Copilot review thread(s)'),
    });
    const resolved = pull({ copilot: { reviewed: true, openThreads: 0 } });
    expect(mergeStep(APPROVAL, resolved, 'none', copilot)).toEqual({
      kind: 'merge',
    });
    expect(mergeStep(APPROVAL, threads, 'none', RULES)).toEqual({
      kind: 'merge',
    });
  });

  it('bounces a pull request GitHub places in another repository, even merged', () => {
    const fork = pull({
      state: 'merged',
      repository: {
        hostname: 'github.com',
        owner: 'mallory',
        name: 'quarterdeck',
      },
    });
    expect(mergeStep(APPROVAL, fork, 'merge', RULES)).toEqual({
      kind: 'bounce',
      reason: `the pull request ${PR} is not in this project's repository github.com/legion/quarterdeck; open it there and report again`,
    });
  });

  it('matches the repository without regard to case', () => {
    const shouty = pull({
      repository: {
        hostname: 'GitHub.com',
        owner: 'Legion',
        name: 'QuarterDeck',
      },
    });
    expect(mergeStep(APPROVAL, shouty, 'none', RULES)).toEqual({
      kind: 'merge',
    });
  });

  it('bounces a pull request into a branch other than the default', () => {
    const release = pull({ base: 'release/1.0' });
    expect(mergeStep(APPROVAL, release, 'merge', RULES)).toEqual({
      kind: 'bounce',
      reason:
        'the pull request merges into release/1.0, not main; retarget it to main and report again',
    });
    expect(
      mergeStep(
        APPROVAL,
        pull({ state: 'merged', base: 'dev' }),
        'none',
        RULES,
      ),
    ).toMatchObject({
      kind: 'bounce',
    });
  });

  it('takes a configured base over the default branch', () => {
    const trunk = { ...RULES, base: 'trunk' };
    expect(mergeStep(APPROVAL, pull({ base: 'trunk' }), 'none', trunk)).toEqual(
      {
        kind: 'merge',
      },
    );
    expect(mergeStep(APPROVAL, pull(), 'none', trunk)).toMatchObject({
      kind: 'bounce',
      reason: expect.stringContaining('not trunk'),
    });
  });

  it('bounces when the repository has no default branch and no base is set', () => {
    expect(
      mergeStep(APPROVAL, pull({ defaultBranch: null }), 'none', RULES),
    ).toEqual({
      kind: 'bounce',
      reason:
        'github.com/legion/quarterdeck has no default branch to merge into; set mergeGate.base',
    });
  });
});

describe('foreign pull request', () => {
  it('accepts a pull request URL in the project repository', () => {
    expect(foreignPullRequest(PR, PROJECT)).toBeUndefined();
    expect(
      foreignPullRequest(
        'https://GITHUB.com/Legion/Quarterdeck/pull/7',
        PROJECT,
      ),
    ).toBeUndefined();
  });

  it('names another owner, repository or host', () => {
    for (const url of [
      'https://github.com/mallory/quarterdeck/pull/23',
      'https://github.com/legion/commander/pull/23',
      'https://ghe.example.com/legion/quarterdeck/pull/23',
    ])
      expect(foreignPullRequest(url, PROJECT)).toBe(
        `the pull request ${url} is not in this project's repository github.com/legion/quarterdeck; open it there and report again`,
      );
  });

  it('names a URL that is not a pull request', () => {
    expect(
      foreignPullRequest('https://github.com/legion/quarterdeck', PROJECT),
    ).toContain('is not a GitHub pull request URL');
  });
});
