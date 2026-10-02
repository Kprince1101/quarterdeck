import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

export type PullRequestState = 'open' | 'merged' | 'closed';
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';
export type ChecksState = 'passing' | 'pending' | 'failing' | 'none';

export interface RepositoryRef {
  hostname: string;
  owner: string;
  name: string;
}

export interface PullRequestRef extends RepositoryRef {
  number: number;
}

export interface PullRequest {
  repository: RepositoryRef;
  base: string;
  defaultBranch: string | null;
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

export type GitRunner = (args: string[]) => Promise<string>;

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

const SCP_REMOTE = /^[^@/:]+@([^:/]+):\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const PATH_REMOTE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const REMOTE_PROTOCOLS: readonly string[] = ['https:', 'http:', 'ssh:'];

const parseUrlRemote = (remote: string): RepositoryRef | undefined => {
  const parsed = URL.parse(remote);
  if (!parsed || !REMOTE_PROTOCOLS.includes(parsed.protocol)) return undefined;
  const match = PATH_REMOTE.exec(parsed.pathname);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    hostname: parsed.hostname.toLowerCase(),
    owner: match[1],
    name: match[2],
  };
};

export const parseRemoteUrl = (remote: string): RepositoryRef => {
  const trimmed = remote.trim();
  const scp = SCP_REMOTE.exec(trimmed);
  if (scp?.[1] && scp[2] && scp[3])
    return { hostname: scp[1].toLowerCase(), owner: scp[2], name: scp[3] };
  const fromUrl = parseUrlRemote(trimmed);
  if (fromUrl) return fromUrl;
  throw new Error(`${trimmed} is not a GitHub repository remote`);
};

export const sameRepository = (a: RepositoryRef, b: RepositoryRef): boolean =>
  a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.name.toLowerCase() === b.name.toLowerCase();

export const repositoryName = (repo: RepositoryRef): string =>
  `${repo.hostname}/${repo.owner}/${repo.name}`;

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

const readCopilot = (pr: Reply): PullRequest['copilot'] => ({
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
    copilot: readCopilot(pr),
  };
};

const exec = promisify(execFile);

const commandError = (command: string, err: unknown): Error => {
  const stderr = (err as { stderr?: unknown }).stderr;
  let detail = String(err);
  if (typeof stderr === 'string' && stderr.trim() !== '')
    detail = stderr.trim();
  else if (err instanceof Error) detail = err.message;
  return new Error(`${command} failed: ${detail}`, { cause: err });
};

export const runGh: GhRunner = async (args) => {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw commandError(`gh ${args.slice(0, 2).join(' ')}`, err);
  }
};

export const runGit: GitRunner = async (args) => {
  try {
    const { stdout } = await exec('git', args);
    return stdout;
  } catch (err) {
    throw commandError(`git ${args.join(' ')}`, err);
  }
};

export const originRepository = async (
  repoPath: string,
  run: GitRunner = runGit,
): Promise<RepositoryRef> =>
  parseRemoteUrl(await run(['-C', repoPath, 'remote', 'get-url', 'origin']));

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
