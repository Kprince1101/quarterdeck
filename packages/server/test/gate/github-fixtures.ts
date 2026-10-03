export const GITHUB_HEAD = '0123456789abcdef0123456789abcdef01234567';

export interface Who {
  login: string;
  __typename: string;
}

export interface GithubShape {
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  head?: string;
  rollup?: unknown;
  reviews?: (Who | null)[];
  threads?: { isResolved: boolean; author: Who | null }[];
  base?: string;
  nameWithOwner?: string;
  repoUrl?: string;
  defaultBranch?: string | null;
}

export const COPILOT: Who = {
  login: 'copilot-pull-request-reviewer',
  __typename: 'Bot',
};

export const user = (login: string): Who => ({ login, __typename: 'User' });

const login = (author: Who | null) => ({ author });

const defaultBranchOf = (shape: GithubShape) => {
  if (shape.defaultBranch === null) return null;
  return { name: shape.defaultBranch ?? 'main' };
};

const rollupOf = (shape: GithubShape): unknown => {
  if (Object.hasOwn(shape, 'rollup')) return shape.rollup;
  return { state: 'SUCCESS', contexts: { nodes: [] } };
};

export const githubReply = (shape: GithubShape = {}): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          repository: {
            nameWithOwner: shape.nameWithOwner ?? 'example-org/quarterdeck',
            url: shape.repoUrl ?? 'https://github.com/example-org/quarterdeck',
            defaultBranchRef: defaultBranchOf(shape),
          },
          baseRefName: shape.base ?? 'main',
          state: shape.state ?? 'OPEN',
          isDraft: shape.isDraft ?? false,
          mergeable: shape.mergeable ?? 'MERGEABLE',
          headRefOid: shape.head ?? GITHUB_HEAD,
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
              comments: { nodes: [login(thread.author)] },
            })),
          },
        },
      },
    },
  });
