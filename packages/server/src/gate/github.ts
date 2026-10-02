import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

export type PullRequestState = 'open' | 'merged' | 'closed';
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';
export type ChecksState = 'passing' | 'pending' | 'failing' | 'none';

export interface PullRequest {
  state: PullRequestState;
  head: string;
  draft: boolean;
  mergeable: Mergeable;
  checks: { state: ChecksState; failing: string[] };
  copilot: { reviewed: boolean; openThreads: number };
}

export interface GitHubHost {
  pullRequest: (url: string) => Promise<PullRequest>;
  squashMerge: (url: string, head: string) => Promise<void>;
}

export type GhRunner = (args: string[]) => Promise<string>;

export interface PullRequestRef {
  hostname: string;
  owner: string;
  name: string;
  number: number;
}

export const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
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
      reviews(first: 100) { nodes { author { login } } }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 1) { nodes { author { login } } }
        }
      }
    }
  }
}`;

const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

export const parsePullRequestUrl = (url: string): PullRequestRef => {
  const parsed = URL.parse(url);
  const match = parsed && PULL_PATH.exec(parsed.pathname);
  if (!parsed || !match?.[1] || !match[2] || !match[3])
    throw new Error(`${url} is not a GitHub pull request URL`);
  return {
    hostname: parsed.hostname,
    owner: match[1],
    name: match[2],
    number: Number(match[3]),
  };
};

const author = z.object({ login: z.string() }).nullable();

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

export const isCopilot = (login: string | undefined): boolean =>
  login?.toLowerCase().startsWith('copilot') ?? false;

const readCopilot = (pr: Reply): PullRequest['copilot'] => ({
  reviewed: pr.reviews.nodes.some((review) => isCopilot(review.author?.login)),
  openThreads: pr.reviewThreads.nodes.filter(
    (thread) =>
      !thread.isResolved && isCopilot(thread.comments.nodes[0]?.author?.login),
  ).length,
});

export const parsePullRequest = (url: string, json: string): PullRequest => {
  const pr = replySchema.parse(JSON.parse(json)).data.repository?.pullRequest;
  if (!pr) throw new Error(`GitHub has no pull request at ${url}`);
  const rollup = pr.commits.nodes.at(-1)?.commit.statusCheckRollup ?? null;
  return {
    state: PR_STATES[pr.state],
    head: pr.headRefOid,
    draft: pr.isDraft,
    mergeable: MERGEABLE[pr.mergeable],
    checks: readChecks(rollup),
    copilot: readCopilot(pr),
  };
};

const exec = promisify(execFile);

const ghError = (args: string[], err: unknown): Error => {
  const stderr = (err as { stderr?: unknown }).stderr;
  let detail = String(err);
  if (typeof stderr === 'string' && stderr.trim() !== '')
    detail = stderr.trim();
  else if (err instanceof Error) detail = err.message;
  return new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`, {
    cause: err,
  });
};

export const runGh: GhRunner = async (args) => {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw ghError(args, err);
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

export const ghCli = (run: GhRunner = runGh): GitHubHost => ({
  pullRequest: async (url) =>
    parsePullRequest(url, await run(pullRequestArgs(url))),
  squashMerge: async (url, head) => {
    await run(squashMergeArgs(url, head));
  },
});
