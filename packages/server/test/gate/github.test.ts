import { describe, expect, it } from 'vitest';
import {
  PULL_REQUEST_QUERY,
  ghCli,
  parsePullRequest,
  parsePullRequestUrl,
  type GhRunner,
} from '../../src/gate/index.js';

const PR = 'https://github.com/legion/quarterdeck/pull/23';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

interface Shape {
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  rollup?: unknown;
  reviews?: (string | null)[];
  threads?: { isResolved: boolean; login: string | null }[];
}

const login = (name: string | null) => {
  if (name === null) return { author: null };
  return { author: { login: name } };
};

const rollupOf = (shape: Shape): unknown => {
  if (Object.hasOwn(shape, 'rollup')) return shape.rollup;
  return { state: 'SUCCESS', contexts: { nodes: [] } };
};

const reply = (shape: Shape = {}): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: shape.state ?? 'OPEN',
          isDraft: shape.isDraft ?? false,
          mergeable: shape.mergeable ?? 'MERGEABLE',
          headRefOid: HEAD,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: rollupOf(shape),
                },
              },
            ],
          },
          reviews: { nodes: (shape.reviews ?? []).map(login) },
          reviewThreads: {
            nodes: (shape.threads ?? []).map((thread) => ({
              isResolved: thread.isResolved,
              comments: { nodes: [login(thread.login)] },
            })),
          },
        },
      },
    },
  });

describe('gh pull request host', () => {
  it('parses a pull request URL', () => {
    expect(parsePullRequestUrl(PR)).toEqual({
      hostname: 'github.com',
      owner: 'legion',
      name: 'quarterdeck',
      number: 23,
    });
    expect(
      parsePullRequestUrl('https://ghe.example.com/a/b/pull/7/').hostname,
    ).toBe('ghe.example.com');
  });

  it('refuses a URL that is not a pull request', () => {
    for (const url of [
      'https://github.com/legion/quarterdeck/issues/23',
      'https://github.com/legion/quarterdeck',
      'not a url',
    ])
      expect(() => parsePullRequestUrl(url)).toThrow(
        'is not a GitHub pull request URL',
      );
  });

  it('reads an open, mergeable pull request with passing checks', () => {
    expect(parsePullRequest(PR, reply())).toEqual({
      state: 'open',
      head: HEAD,
      draft: false,
      mergeable: 'mergeable',
      checks: { state: 'passing', failing: [] },
      copilot: { reviewed: false, openThreads: 0 },
    });
  });

  it('maps merged, closed, draft and conflicting', () => {
    expect(parsePullRequest(PR, reply({ state: 'MERGED' })).state).toBe(
      'merged',
    );
    expect(parsePullRequest(PR, reply({ state: 'CLOSED' })).state).toBe(
      'closed',
    );
    expect(parsePullRequest(PR, reply({ isDraft: true })).draft).toBe(true);
    expect(
      parsePullRequest(PR, reply({ mergeable: 'CONFLICTING' })).mergeable,
    ).toBe('conflicting');
    expect(
      parsePullRequest(PR, reply({ mergeable: 'UNKNOWN' })).mergeable,
    ).toBe('unknown');
  });

  it('names the failing checks and statuses', () => {
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { __typename: 'CheckRun', name: 'validate', conclusion: 'FAILURE' },
          { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'slow', conclusion: 'TIMED_OUT' },
          { __typename: 'CheckRun', name: 'running', conclusion: null },
          { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
          { __typename: 'StatusContext', context: 'ci/ok', state: 'SUCCESS' },
        ],
      },
    };

    expect(parsePullRequest(PR, reply({ rollup })).checks).toEqual({
      state: 'failing',
      failing: ['validate', 'slow', 'ci/legacy'],
    });
  });

  it('reads pending and absent checks', () => {
    const pending = { state: 'PENDING', contexts: { nodes: [] } };
    const expected = { state: 'EXPECTED', contexts: { nodes: [] } };

    expect(parsePullRequest(PR, reply({ rollup: pending })).checks.state).toBe(
      'pending',
    );
    expect(parsePullRequest(PR, reply({ rollup: expected })).checks.state).toBe(
      'pending',
    );
    expect(parsePullRequest(PR, reply({ rollup: null })).checks).toEqual({
      state: 'none',
      failing: [],
    });
  });

  it('counts Copilot reviews and its unresolved threads only', () => {
    const pr = parsePullRequest(
      PR,
      reply({
        reviews: ['heron', null, 'copilot-pull-request-reviewer'],
        threads: [
          { isResolved: false, login: 'copilot-pull-request-reviewer' },
          { isResolved: true, login: 'copilot-pull-request-reviewer' },
          { isResolved: false, login: 'heron' },
          { isResolved: false, login: null },
        ],
      }),
    );

    expect(pr.copilot).toEqual({ reviewed: true, openThreads: 1 });
  });

  it('throws when GitHub has no such pull request', () => {
    const missing = JSON.stringify({
      data: { repository: { pullRequest: null } },
    });

    expect(() => parsePullRequest(PR, missing)).toThrow(
      `GitHub has no pull request at ${PR}`,
    );
  });

  it('asks gh for the pull request with bound variables, never an inlined value', async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      return reply();
    };

    const pr = await ghCli(run).pullRequest(PR);

    expect(pr.head).toBe(HEAD);
    expect(calls).toEqual([
      [
        'api',
        'graphql',
        '--hostname',
        'github.com',
        '-f',
        `query=${PULL_REQUEST_QUERY}`,
        '-f',
        'owner=legion',
        '-f',
        'name=quarterdeck',
        '-F',
        'number=23',
      ],
    ]);
  });

  it('squash merges only at the approved head', async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      return '';
    };

    await ghCli(run).squashMerge(PR, HEAD);

    expect(calls).toEqual([
      ['pr', 'merge', PR, '--squash', '--match-head-commit', HEAD],
    ]);
  });

  it('refuses to merge a URL that is not a pull request', async () => {
    const run: GhRunner = async () => '';

    await expect(
      ghCli(run).squashMerge('https://example.com/nope', HEAD),
    ).rejects.toThrow('is not a GitHub pull request URL');
  });
});
