import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  OPEN_PULL_REQUEST_FIELDS,
  OPEN_PULL_REQUEST_LIMIT,
  PULL_REQUEST_QUERY,
  ghCli,
  isCopilot,
  originRepository,
  parsePullRequest,
  parsePullRequestUrl,
  parseRemoteUrl,
  sameRepository,
  type GhRunner,
  type GitRunner,
} from '../../src/gate/index.js';
import {
  COPILOT,
  GITHUB_HEAD as HEAD,
  githubReply as reply,
  user,
} from './github-fixtures.ts';

const exec = promisify(execFile);

const PR = 'https://github.com/example-org/quarterdeck/pull/23';

describe('gh pull request host', () => {
  it('parses a pull request URL', () => {
    expect(parsePullRequestUrl(PR)).toEqual({
      hostname: 'github.com',
      owner: 'example-org',
      name: 'quarterdeck',
      number: 23,
    });
    expect(
      parsePullRequestUrl('https://ghe.example.com/a/b/pull/7/').hostname,
    ).toBe('ghe.example.com');
  });

  it('refuses a URL that is not a pull request', () => {
    for (const url of [
      'https://github.com/example-org/quarterdeck/issues/23',
      'https://github.com/example-org/quarterdeck',
      'not a url',
    ])
      expect(() => parsePullRequestUrl(url)).toThrow(
        'is not a GitHub pull request URL',
      );
  });

  it('reads an open, mergeable pull request with passing checks', () => {
    expect(parsePullRequest(PR, reply())).toEqual({
      repository: {
        hostname: 'github.com',
        owner: 'example-org',
        name: 'quarterdeck',
      },
      base: 'main',
      defaultBranch: 'main',
      state: 'open',
      head: HEAD,
      draft: false,
      mergeable: 'mergeable',
      checks: { state: 'passing', failing: [] },
      botReview: { reviewed: false, openThreads: 0 },
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

  it('reads the repository, base and default branch GitHub reports', () => {
    const pr = parsePullRequest(
      PR,
      reply({
        nameWithOwner: 'Example-Org/Quarterdeck',
        repoUrl: 'https://GHE.example.com/Example-Org/Quarterdeck',
        base: 'release/1.0',
        defaultBranch: null,
      }),
    );

    expect(pr.repository).toEqual({
      hostname: 'ghe.example.com',
      owner: 'Example-Org',
      name: 'Quarterdeck',
    });
    expect(pr.base).toBe('release/1.0');
    expect(pr.defaultBranch).toBeNull();
  });

  it('counts Copilot reviews and its unresolved threads only', () => {
    const pr = parsePullRequest(
      PR,
      reply({
        reviews: [user('heron'), null, COPILOT],
        threads: [
          { isResolved: false, author: COPILOT },
          { isResolved: true, author: COPILOT },
          { isResolved: false, author: user('heron') },
          { isResolved: false, author: null },
        ],
      }),
    );

    expect(pr.botReview).toEqual({ reviewed: true, openThreads: 1 });
  });

  it('does not take a user whose login starts with copilot for Copilot', () => {
    const pr = parsePullRequest(
      PR,
      reply({
        reviews: [user('copilot-fan'), user('Copilot')],
        threads: [{ isResolved: false, author: user('copilot-fan') }],
      }),
    );

    expect(pr.botReview).toEqual({ reviewed: false, openThreads: 0 });
  });

  it('knows Copilot by its exact bot logins', () => {
    expect(isCopilot(COPILOT)).toBe(true);
    expect(isCopilot({ login: 'Copilot', __typename: 'Bot' })).toBe(true);
    expect(isCopilot({ login: 'Copilot' })).toBe(true);
    expect(isCopilot({ login: 'copilot-fan', __typename: 'Bot' })).toBe(false);
    expect(isCopilot({ login: 'copilot', __typename: 'Bot' })).toBe(false);
    expect(isCopilot(user('copilot-pull-request-reviewer'))).toBe(false);
    expect(isCopilot(null)).toBe(false);
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
        'owner=example-org',
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

  it('is the github forge', () => {
    expect(ghCli(async () => '').forge).toBe('github');
  });

  it('lists the open pull requests of a repository', async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      return JSON.stringify([
        {
          url: PR,
          number: 23,
          title: 'Add the forge seam',
          headRefName: 'qd19',
          headRefOid: HEAD,
          isDraft: false,
          author: { login: 'okapi' },
        },
        {
          url: 'https://github.com/example-org/quarterdeck/pull/24',
          number: 24,
          title: 'Draft',
          headRefName: 'wip',
          headRefOid: HEAD,
          isDraft: true,
          author: null,
        },
      ]);
    };

    const open = await ghCli(run).listOpen({
      hostname: 'github.com',
      owner: 'example-org',
      name: 'quarterdeck',
    });

    expect(calls).toEqual([
      [
        'pr',
        'list',
        '--repo',
        'github.com/example-org/quarterdeck',
        '--state',
        'open',
        '--limit',
        String(OPEN_PULL_REQUEST_LIMIT),
        '--json',
        OPEN_PULL_REQUEST_FIELDS,
      ],
    ]);
    expect(open).toEqual([
      {
        url: PR,
        number: 23,
        title: 'Add the forge seam',
        branch: 'qd19',
        head: HEAD,
        draft: false,
        author: 'okapi',
      },
      {
        url: 'https://github.com/example-org/quarterdeck/pull/24',
        number: 24,
        title: 'Draft',
        branch: 'wip',
        head: HEAD,
        draft: true,
        author: null,
      },
    ]);
  });
});

describe('project repository', () => {
  const QUARTERDECK = {
    hostname: 'github.com',
    owner: 'example-org',
    name: 'quarterdeck',
  };

  it('parses https, ssh and scp-style remotes', () => {
    for (const remote of [
      'https://github.com/example-org/quarterdeck.git',
      'https://github.com/example-org/quarterdeck',
      'https://token@github.com/example-org/quarterdeck.git/\n',
      'ssh://git@github.com/example-org/quarterdeck.git',
      'ssh://git@github.com:22/example-org/quarterdeck',
      'git@github.com:example-org/quarterdeck.git',
      'git@GitHub.com:example-org/quarterdeck',
    ])
      expect(parseRemoteUrl(remote)).toEqual(QUARTERDECK);
  });

  it('keeps a nested namespace as the owner', () => {
    const nested = {
      hostname: 'gitlab.com',
      owner: 'group/subgroup',
      name: 'project',
    };
    for (const remote of [
      'git@gitlab.com:group/subgroup/project.git',
      'https://gitlab.com/group/subgroup/project.git',
      'ssh://git@gitlab.com/group/subgroup/project/',
    ])
      expect(parseRemoteUrl(remote)).toEqual(nested);
  });

  it('refuses a remote it cannot place on a host', () => {
    for (const remote of [
      '/srv/git/quarterdeck.git',
      'file:///srv/git/quarterdeck.git',
      'https://github.com/quarterdeck',
      '',
    ])
      expect(() => parseRemoteUrl(remote)).toThrow(
        'is not a repository remote with a host, owner and name',
      );
  });

  it('compares repositories without regard to case', () => {
    expect(
      sameRepository(QUARTERDECK, {
        hostname: 'GitHub.com',
        owner: 'Example-Org',
        name: 'Quarterdeck',
      }),
    ).toBe(true);
    expect(
      sameRepository(QUARTERDECK, { ...QUARTERDECK, owner: 'mallory' }),
    ).toBe(false);
  });

  it('asks git for the origin remote of the repo path', async () => {
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      return 'git@github.com:example-org/quarterdeck.git\n';
    };

    expect(await originRepository('/repos/quarterdeck', run)).toEqual(
      QUARTERDECK,
    );
    expect(calls).toEqual([
      ['-C', '/repos/quarterdeck', 'remote', 'get-url', 'origin'],
    ]);
  });

  it('reads the origin of a real checkout, and fails without one', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'quarterdeck-origin-'));
    try {
      await exec('git', ['init', '-q', root]);
      await expect(originRepository(root)).rejects.toThrow(
        `git -C ${root} remote get-url origin failed`,
      );
      await exec('git', [
        '-C',
        root,
        'remote',
        'add',
        'origin',
        'https://github.com/example-org/quarterdeck.git',
      ]);
      expect(await originRepository(root)).toEqual(QUARTERDECK);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
