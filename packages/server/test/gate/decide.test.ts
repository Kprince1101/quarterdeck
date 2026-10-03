import {
  AiReviewConfigError,
  forgeTerms,
  type MergeGate,
} from '@quarterdeck/rules';
import { describe, expect, it } from 'vitest';
import {
  foreignPullRequest as decideForeign,
  mergeStep as decideMerge,
  parsePullRequestUrl,
  reviewStep,
  waitingReasons,
  type Approval,
  type MergeCardState,
  type PullRequest,
  type RepositoryRef,
} from '../../src/gate/index.js';
import type { TicketFacts } from '../../src/gate/facts.js';

const PROJECT: RepositoryRef = {
  hostname: 'github.com',
  owner: 'example-org',
  name: 'quarterdeck',
};

const GITHUB = forgeTerms('github');
const GITLAB = forgeTerms('gitlab');
const WAITING = waitingReasons(GITHUB);

const PR = 'https://github.com/example-org/quarterdeck/pull/23';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

const COPILOT = ['copilot-pull-request-reviewer', 'Copilot'];

const RULES: MergeGate = {
  requireReviewerApproval: true,
  requireChecksPassing: true,
  requireAiReview: false,
  aiReviewers: { github: COPILOT, gitlab: [] },
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
) => decideMerge(approval, pr, card, rules, PROJECT, 'github');

const foreignPullRequest = (
  url: string,
  project: RepositoryRef,
  terms: typeof GITHUB,
) => decideForeign(url, project, terms, parsePullRequestUrl);

const pull = (extra: Partial<PullRequest> = {}): PullRequest => ({
  repository: PROJECT,
  base: 'main',
  defaultBranch: 'main',
  state: 'open',
  head: HEAD,
  draft: false,
  mergeable: 'mergeable',
  checks: { state: 'passing', failing: [] },
  botReview: { reviewers: [], openThreads: [] },
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

  it('gates on the AI review only when asked to', () => {
    const ai = { ...RULES, requireAiReview: true };
    expect(mergeStep(APPROVAL, pull(), 'none', ai)).toEqual({
      kind: 'wait',
      reason:
        'waiting for an AI review from copilot-pull-request-reviewer or Copilot',
    });
    const threads = pull({
      botReview: {
        reviewers: ['copilot-pull-request-reviewer'],
        openThreads: ['Copilot', 'Copilot'],
      },
    });
    expect(mergeStep(APPROVAL, threads, 'none', ai)).toEqual({
      kind: 'bounce',
      reason:
        '2 AI review thread(s) from Copilot are unresolved on the pull request; answer and resolve each, then report again',
    });
    const resolved = pull({
      botReview: { reviewers: ['Copilot'], openThreads: [] },
    });
    expect(mergeStep(APPROVAL, resolved, 'none', ai)).toEqual({
      kind: 'merge',
    });
    expect(mergeStep(APPROVAL, threads, 'none', RULES)).toEqual({
      kind: 'merge',
    });
  });

  it('counts only the configured bots as the AI review', () => {
    const ai = { ...RULES, requireAiReview: true };
    const others = pull({
      botReview: {
        reviewers: ['renovate', 'dependabot'],
        openThreads: ['dependabot'],
      },
    });
    expect(mergeStep(APPROVAL, others, 'none', ai)).toEqual({
      kind: 'wait',
      reason:
        'waiting for an AI review from copilot-pull-request-reviewer or Copilot',
    });
  });

  it('refuses requireAiReview with no logins for the forge, naming the file', () => {
    const ai = {
      ...RULES,
      requireAiReview: true,
      aiReviewers: { github: [], gitlab: [] },
    };
    expect(() => mergeStep(APPROVAL, pull(), 'none', ai)).toThrow(
      AiReviewConfigError,
    );
    expect(() => mergeStep(APPROVAL, pull(), 'none', ai)).toThrow(
      '~/.quarterdeck/rules.local.lifecycle.json: mergeGate.requireAiReview is on, but mergeGate.aiReviewers.github lists no GitHub bot logins',
    );
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
      reason: `the pull request ${PR} is not in this project's repository github.com/example-org/quarterdeck; open it there and report again`,
    });
  });

  it('matches the repository without regard to case', () => {
    const shouty = pull({
      repository: {
        hostname: 'GitHub.com',
        owner: 'Example-Org',
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
        'github.com/example-org/quarterdeck has no default branch to merge into; set mergeGate.base',
    });
  });
});

describe('foreign pull request', () => {
  it('accepts a pull request URL in the project repository', () => {
    expect(foreignPullRequest(PR, PROJECT, GITHUB)).toBeUndefined();
    expect(
      foreignPullRequest(
        'https://GITHUB.com/Example-Org/Quarterdeck/pull/7',
        PROJECT,
        GITHUB,
      ),
    ).toBeUndefined();
  });

  it('names another owner, repository or host', () => {
    for (const url of [
      'https://github.com/mallory/quarterdeck/pull/23',
      'https://github.com/example-org/example/pull/23',
      'https://ghe.example.com/example-org/quarterdeck/pull/23',
    ])
      expect(foreignPullRequest(url, PROJECT, GITHUB)).toBe(
        `the pull request ${url} is not in this project's repository github.com/example-org/quarterdeck; open it there and report again`,
      );
  });

  it('names a URL that is not a pull request', () => {
    expect(
      foreignPullRequest(
        'https://github.com/example-org/quarterdeck',
        PROJECT,
        GITHUB,
      ),
    ).toContain('is not a GitHub pull request URL');
  });

  it('reads the URL with the forge host’s own parser', () => {
    const mr = 'https://git.example.org/group/subgroup/deck/-/merge_requests/9';
    const project = {
      hostname: 'git.example.org',
      owner: 'group/subgroup',
      name: 'deck',
    };
    const parse = (url: string) => {
      const match =
        /^https:\/\/([^/]+)\/(.+)\/([^/]+)\/-\/merge_requests\/(\d+)$/.exec(
          url,
        );
      if (!match?.[1] || !match[2] || !match[3]) throw new Error('not an MR');
      return {
        hostname: match[1],
        owner: match[2],
        name: match[3],
        number: Number(match[4]),
      };
    };

    expect(decideForeign(mr, project, GITLAB, parse)).toBeUndefined();
    expect(decideForeign(PR, project, GITLAB, parse)).toBe(
      `${PR} is not a GitLab merge request URL; report the merge request's URL`,
    );
  });
});

describe('gate reasons in a GitLab project', () => {
  const GITLAB_PROJECT: RepositoryRef = {
    hostname: 'git.example.org',
    owner: 'example-org',
    name: 'quarterdeck',
  };
  const gitlabStep = (
    pr: PullRequest,
    card: MergeCardState = 'none',
    rules: MergeGate = RULES,
  ) => decideMerge(APPROVAL, pr, card, rules, GITLAB_PROJECT, 'gitlab');
  const onGitlab = (extra: Partial<PullRequest> = {}) =>
    pull({ repository: GITLAB_PROJECT, ...extra });
  const reasons = (): string[] =>
    [
      gitlabStep(onGitlab({ state: 'closed' })),
      gitlabStep(onGitlab({ head: OTHER })),
      gitlabStep(onGitlab({ mergeable: 'conflicting' })),
      gitlabStep(onGitlab({ base: 'release/1.0' })),
      gitlabStep(onGitlab({ draft: true })),
      gitlabStep(onGitlab({ mergeable: 'unknown' })),
      gitlabStep(pull()),
    ].map((step) => {
      if (!('reason' in step)) throw new Error(`no reason in ${step.kind}`);
      return step.reason;
    });

  it('says merge request, never pull request', () => {
    expect(reasons()).toEqual([
      'the merge request was closed without merging; reopen it or open a new one and report again',
      `the merge request head is ${OTHER}, not the approved ${HEAD}; report the new head for review`,
      'the merge request conflicts with its base; rebase, push and report again',
      'the merge request merges into release/1.0, not main; retarget it to main and report again',
      'waiting: the merge request is a draft',
      'waiting for GitLab to work out whether it merges cleanly',
      `the merge request ${PR} is not in this project's repository git.example.org/example-org/quarterdeck; open it there and report again`,
    ]);
    for (const reason of reasons()) {
      expect(reason).not.toMatch(/pull request|\bPR\b|GitHub/);
    }
    expect(
      foreignPullRequest('https://git.example.org/a/b', GITLAB_PROJECT, GITLAB),
    ).toBe(
      "https://git.example.org/a/b is not a GitLab merge request URL; report the merge request's URL",
    );
  });

  it('waits for a configured GitLab bot, then passes once it has reviewed', () => {
    const ai = {
      ...RULES,
      requireAiReview: true,
      aiReviewers: { github: COPILOT, gitlab: ['review-bot'] },
    };
    expect(gitlabStep(onGitlab(), 'none', ai)).toEqual({
      kind: 'wait',
      reason: 'waiting for an AI review from review-bot',
    });
    const threads = onGitlab({
      botReview: { reviewers: ['review-bot'], openThreads: ['review-bot'] },
    });
    expect(gitlabStep(threads, 'none', ai)).toEqual({
      kind: 'bounce',
      reason:
        '1 AI review thread(s) from review-bot are unresolved on the merge request; answer and resolve each, then report again',
    });
    const reviewed = onGitlab({
      botReview: { reviewers: ['review-bot'], openThreads: [] },
    });
    expect(gitlabStep(reviewed, 'none', ai)).toEqual({ kind: 'merge' });
  });

  it('is a config error to require an AI review on GitLab with no logins', () => {
    const ai = { ...RULES, requireAiReview: true };
    expect(() => gitlabStep(onGitlab(), 'none', ai)).toThrow(
      '~/.quarterdeck/rules.local.lifecycle.json: mergeGate.requireAiReview is on, but mergeGate.aiReviewers.gitlab lists no GitLab bot logins',
    );
  });

  it('keeps pull request wording for a GitHub project', () => {
    expect(mergeStep(APPROVAL, pull({ draft: true }), 'none', RULES)).toEqual({
      kind: 'wait',
      reason: 'waiting: the pull request is a draft',
    });
  });
});
