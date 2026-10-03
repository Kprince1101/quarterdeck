import type { Forge } from '@quarterdeck/rules';
import {
  ghCli,
  glabCli,
  type ChecksState,
  type ForgeHost,
  type Mergeable,
  type PullRequest,
  type PullRequestState,
  type RepositoryRef,
} from '../../src/gate/index.js';
import {
  COPILOT,
  githubReply,
  type GithubShape,
  type Who,
} from './github-fixtures.ts';
import {
  DUO,
  gitlabJob,
  glabAnswers,
  type GitlabShape,
  type GitlabThread,
} from './gitlab-fixtures.ts';

export interface ForgeCase {
  forge: Forge;
  origin: string;
  repository: RepositoryRef;
  pr: string;
  foreign: string;
}

export const FORGE_CASES: Record<Forge, ForgeCase> = {
  github: {
    forge: 'github',
    origin: 'git@github.com:example-org/quarterdeck.git',
    repository: {
      hostname: 'github.com',
      owner: 'example-org',
      name: 'quarterdeck',
    },
    pr: 'https://github.com/example-org/quarterdeck/pull/23',
    foreign: 'https://github.com/mallory/payroll/pull/9',
  },
  gitlab: {
    forge: 'gitlab',
    origin: 'git@git.example.org:example-group/platform/quarterdeck.git',
    repository: {
      hostname: 'git.example.org',
      owner: 'example-group/platform',
      name: 'quarterdeck',
    },
    pr: 'https://git.example.org/example-group/platform/quarterdeck/-/merge_requests/23',
    foreign: 'https://git.example.org/mallory/payroll/-/merge_requests/9',
  },
};

const GITHUB_STATES: Record<PullRequestState, string> = {
  open: 'OPEN',
  merged: 'MERGED',
  closed: 'CLOSED',
};

const GITHUB_MERGEABLE: Record<Mergeable, string> = {
  mergeable: 'MERGEABLE',
  conflicting: 'CONFLICTING',
  unknown: 'UNKNOWN',
};

const githubContexts = (failing: string[]) => ({
  nodes: failing.map((name) => ({
    __typename: 'CheckRun',
    name,
    conclusion: 'FAILURE',
  })),
});

const GITHUB_ROLLUPS: Record<ChecksState, (failing: string[]) => unknown> = {
  none: () => null,
  passing: () => ({ state: 'SUCCESS', contexts: githubContexts([]) }),
  pending: () => ({ state: 'PENDING', contexts: githubContexts([]) }),
  failing: (failing) => ({
    state: 'FAILURE',
    contexts: githubContexts(failing),
  }),
};

const repeat = <T>(count: number, item: T): T[] =>
  Array.from({ length: count }, () => item);

const githubShape = (pr: PullRequest): GithubShape => {
  const reviews: Who[] = [];
  if (pr.botReview.reviewed) reviews.push(COPILOT);
  return {
    state: GITHUB_STATES[pr.state],
    isDraft: pr.draft,
    mergeable: GITHUB_MERGEABLE[pr.mergeable],
    head: pr.head,
    rollup: GITHUB_ROLLUPS[pr.checks.state](pr.checks.failing),
    reviews,
    threads: repeat(pr.botReview.openThreads, {
      isResolved: false,
      author: COPILOT,
    }),
    base: pr.base,
    nameWithOwner: `${pr.repository.owner}/${pr.repository.name}`,
    repoUrl: `https://${pr.repository.hostname}/${pr.repository.owner}/${pr.repository.name}`,
    defaultBranch: pr.defaultBranch,
  };
};

const GITLAB_STATES: Record<PullRequestState, string> = {
  open: 'opened',
  merged: 'merged',
  closed: 'closed',
};

const GITLAB_MERGEABLE: Record<Mergeable, Record<string, unknown>> = {
  mergeable: { detailed_merge_status: 'mergeable', has_conflicts: false },
  conflicting: { detailed_merge_status: 'conflict', has_conflicts: true },
  unknown: { detailed_merge_status: 'checking', has_conflicts: false },
};

const GITLAB_PIPELINES: Record<ChecksState, Record<string, unknown> | null> = {
  none: null,
  passing: { status: 'success' },
  pending: { status: 'running' },
  failing: { status: 'failed' },
};

const gitlabThreads = (pr: PullRequest): GitlabThread[] => {
  const threads = repeat<GitlabThread>(pr.botReview.openThreads, {
    author: DUO,
  });
  if (pr.botReview.reviewed) threads.push({ author: DUO, resolved: true });
  return threads;
};

const gitlabShape = (pr: PullRequest): GitlabShape => ({
  mergeRequest: {
    state: GITLAB_STATES[pr.state],
    draft: pr.draft,
    sha: pr.head,
    target_branch: pr.base,
    ...GITLAB_MERGEABLE[pr.mergeable],
  },
  pipeline: GITLAB_PIPELINES[pr.checks.state],
  project: {
    path_with_namespace: `${pr.repository.owner}/${pr.repository.name}`,
    web_url: `https://${pr.repository.hostname}/${pr.repository.owner}/${pr.repository.name}`,
    default_branch: pr.defaultBranch,
  },
  threads: gitlabThreads(pr),
  jobs: pr.checks.failing.map((name) => gitlabJob(name)),
});

const RECORDED_CLIS: Record<
  Forge,
  (pr: () => PullRequest, calls: string[][]) => ForgeHost
> = {
  github: (pr, calls) =>
    ghCli(async (args) => {
      calls.push(args);
      if (args[0] === 'pr') return '';
      return githubReply(githubShape(pr()));
    }),
  gitlab: (pr, calls) => glabCli(glabAnswers(() => gitlabShape(pr()), calls)),
};

export const recordedCli = (
  forge: Forge,
  pr: () => PullRequest,
  calls: string[][],
): ForgeHost => RECORDED_CLIS[forge](pr, calls);
