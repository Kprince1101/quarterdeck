import { z } from 'zod';
import type {
  ChecksState,
  ForgeHost,
  Mergeable,
  OpenPullRequest,
  PullRequest,
  PullRequestRef,
  PullRequestState,
  RepositoryRef,
} from './forge.js';
import { exec, execError, repositoryName } from './repository.js';

export type GhRunner = (args: string[]) => Promise<string>;

export const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      repository { nameWithOwner url defaultBranchRef { name } }
      baseRefName
      state
      isDraft
      mergeable
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
      reviews(first: 100) { nodes { author { login __typename } } }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 1) { nodes { author { login __typename } } }
        }
      }
    }
  }
}`;

export const OPEN_PULL_REQUEST_FIELDS =
  'url,number,title,headRefName,headRefOid,isDraft,author';

export const OPEN_PULL_REQUEST_LIMIT = 100;

const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

export const parsePullRequestUrl = (url: string): PullRequestRef => {
  const parsed = URL.parse(url);
  const match = parsed && PULL_PATH.exec(parsed.pathname);
  if (!parsed || !match?.[1] || !match[2] || !match[3])
    throw new Error(`${url} is not a GitHub pull request URL`);
  return {
    hostname: parsed.hostname.toLowerCase(),
    owner: match[1],
    name: match[2],
    number: Number(match[3]),
  };
};

const author = z
  .object({ login: z.string(), __typename: z.string().optional() })
  .nullable();

const repositorySchema = z.object({
  nameWithOwner: z.string(),
  url: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
});

const contextSchema = z.object({
  __typename: z.string(),
  name: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  context: z.string().optional(),
  state: z.string().optional(),
});

const replySchema = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            repository: repositorySchema,
            baseRefName: z.string(),
            state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
            isDraft: z.boolean(),
            mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
            headRefOid: z.string(),
            commits: z.object({
              nodes: z.array(
                z.object({
                  commit: z.object({
                    statusCheckRollup: z
                      .object({
                        state: z.string(),
                        contexts: z.object({ nodes: z.array(contextSchema) }),
                      })
                      .nullable(),
                  }),
                }),
              ),
            }),
            reviews: z.object({
              nodes: z.array(z.object({ author })),
            }),
            reviewThreads: z.object({
              nodes: z.array(
                z.object({
                  isResolved: z.boolean(),
                  comments: z.object({
                    nodes: z.array(z.object({ author })),
                  }),
                }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

const openListSchema = z.array(
  z.object({
    url: z.string(),
    number: z.int(),
    title: z.string(),
    headRefName: z.string(),
    headRefOid: z.string(),
    isDraft: z.boolean(),
    author: z.object({ login: z.string() }).nullable().optional(),
  }),
);

type Reply = NonNullable<
  NonNullable<z.infer<typeof replySchema>['data']['repository']>['pullRequest']
>;
type Rollup = Reply['commits']['nodes'][number]['commit']['statusCheckRollup'];
type CheckContext = z.infer<typeof contextSchema>;

const FAILED_CONCLUSIONS: readonly string[] = [
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
];
const FAILED_STATES: readonly string[] = ['FAILURE', 'ERROR'];
const PR_STATES: Record<Reply['state'], PullRequestState> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
};

const MERGEABLE: Record<Reply['mergeable'], Mergeable> = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
};

const rollupState = (state: string): ChecksState => {
  if (state === 'SUCCESS') return 'passing';
  if (FAILED_STATES.includes(state)) return 'failing';
  return 'pending';
};

const failedContext = (context: CheckContext): string | undefined => {
  if (FAILED_CONCLUSIONS.includes(context.conclusion ?? ''))
    return context.name;
  if (FAILED_STATES.includes(context.state ?? '')) return context.context;
  return undefined;
};

const readChecks = (rollup: Rollup): PullRequest['checks'] => {
  if (rollup === null) return { state: 'none', failing: [] };
  const failing = rollup.contexts.nodes
    .map(failedContext)
    .filter((name) => name !== undefined);
  return { state: rollupState(rollup.state), failing };
};

export const COPILOT_LOGINS: readonly string[] = [
  'copilot-pull-request-reviewer',
  'Copilot',
];

export const isCopilot = (
  who: { login: string; __typename?: string | undefined } | null | undefined,
): boolean =>
  who !== null &&
  who !== undefined &&
  COPILOT_LOGINS.includes(who.login) &&
  who.__typename !== 'User';

const readBotReview = (pr: Reply): PullRequest['botReview'] => ({
  reviewed: pr.reviews.nodes.some((review) => isCopilot(review.author)),
  openThreads: pr.reviewThreads.nodes.filter(
    (thread) =>
      !thread.isResolved && isCopilot(thread.comments.nodes[0]?.author),
  ).length,
});

const readRepository = (
  url: string,
  repo: z.infer<typeof repositorySchema>,
): RepositoryRef => {
  const [owner, name] = repo.nameWithOwner.split('/');
  const hostname = URL.parse(repo.url)?.hostname;
  if (!owner || !name || !hostname)
    throw new Error(`GitHub named an unreadable repository for ${url}`);
  return { hostname: hostname.toLowerCase(), owner, name };
};

export const parsePullRequest = (url: string, json: string): PullRequest => {
  const pr = replySchema.parse(JSON.parse(json)).data.repository?.pullRequest;
  if (!pr) throw new Error(`GitHub has no pull request at ${url}`);
  const rollup = pr.commits.nodes.at(-1)?.commit.statusCheckRollup ?? null;
  return {
    repository: readRepository(url, pr.repository),
    base: pr.baseRefName,
    defaultBranch: pr.repository.defaultBranchRef?.name ?? null,
    state: PR_STATES[pr.state],
    head: pr.headRefOid,
    draft: pr.isDraft,
    mergeable: MERGEABLE[pr.mergeable],
    checks: readChecks(rollup),
    botReview: readBotReview(pr),
  };
};

export const parseOpenPullRequests = (json: string): OpenPullRequest[] =>
  openListSchema.parse(JSON.parse(json)).map((pr) => ({
    url: pr.url,
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    head: pr.headRefOid,
    draft: pr.isDraft,
    author: pr.author?.login ?? null,
  }));

export const runGh: GhRunner = async (args) => {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw execError(`gh ${args.slice(0, 2).join(' ')}`, err);
  }
};

export const pullRequestArgs = (url: string): string[] => {
  const ref = parsePullRequestUrl(url);
  return [
    'api',
    'graphql',
    '--hostname',
    ref.hostname,
    '-f',
    `query=${PULL_REQUEST_QUERY}`,
    '-f',
    `owner=${ref.owner}`,
    '-f',
    `name=${ref.name}`,
    '-F',
    `number=${ref.number}`,
  ];
};

export const squashMergeArgs = (url: string, head: string): string[] => {
  parsePullRequestUrl(url);
  return ['pr', 'merge', url, '--squash', '--match-head-commit', head];
};

export const listOpenArgs = (repository: RepositoryRef): string[] => [
  'pr',
  'list',
  '--repo',
  repositoryName(repository),
  '--state',
  'open',
  '--limit',
  String(OPEN_PULL_REQUEST_LIMIT),
  '--json',
  OPEN_PULL_REQUEST_FIELDS,
];

export const ghCli = (run: GhRunner = runGh): ForgeHost => ({
  forge: 'github',
  pullRequest: async (url) =>
    parsePullRequest(url, await run(pullRequestArgs(url))),
  squashMerge: async (url, head) => {
    await run(squashMergeArgs(url, head));
  },
  listOpen: async (repository) =>
    parseOpenPullRequests(await run(listOpenArgs(repository))),
});
