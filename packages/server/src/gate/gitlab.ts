import { z } from 'zod';
import type {
  BotReview,
  ChecksState,
  ForgeHost,
  Mergeable,
  OpenPullRequest,
  PullRequest,
  PullRequestRef,
  PullRequestState,
  RepositoryRef,
  ReviewState,
} from './forge.js';
import { exec, execError } from './repository.js';

export type GlabRunner = (args: string[]) => Promise<string>;

export const GITLAB_PAGE_SIZE = 100;

const MERGE_REQUEST_PATH = /^\/(.+)\/([^/]+)\/-\/merge_requests\/(\d+)\/?$/;

export const parseMergeRequestUrl = (url: string): PullRequestRef => {
  const parsed = URL.parse(url);
  const match = parsed && MERGE_REQUEST_PATH.exec(parsed.pathname);
  if (!parsed || !match?.[1] || !match[2] || match[1].split('/').includes('-'))
    throw new Error(`${url} is not a GitLab merge request URL`);
  return {
    hostname: parsed.hostname.toLowerCase(),
    owner: match[1],
    name: match[2],
    number: Number(match[3]),
  };
};

const projectPath = (repository: RepositoryRef): string =>
  encodeURIComponent(`${repository.owner}/${repository.name}`);

const glabApi = (hostname: string, endpoint: string): string[] => [
  'api',
  '--hostname',
  hostname,
  endpoint,
];

const mergeRequestEndpoint = (ref: PullRequestRef): string =>
  `projects/${projectPath(ref)}/merge_requests/${ref.number}`;

const pipelineSchema = z.object({
  id: z.int(),
  project_id: z.int().optional(),
  status: z.string(),
});

const mergeRequestSchema = z.object({
  iid: z.int(),
  project_id: z.int(),
  state: z.enum(['opened', 'closed', 'locked', 'merged']),
  target_branch: z.string(),
  sha: z.string().nullable(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  has_conflicts: z.boolean().optional(),
  detailed_merge_status: z.string().optional(),
  merge_status: z.string().optional(),
  head_pipeline: pipelineSchema.nullable().optional(),
});

const projectSchema = z.object({
  path_with_namespace: z.string(),
  web_url: z.string(),
  default_branch: z.string().nullable().optional(),
});

const author = z.object({ username: z.string() }).nullable().optional();

const discussionsSchema = z.array(
  z.object({
    notes: z.array(
      z.object({
        author,
        system: z.boolean().optional(),
        resolvable: z.boolean().optional(),
        resolved: z.boolean().optional(),
      }),
    ),
  }),
);

const jobsSchema = z.array(
  z.object({ name: z.string(), allow_failure: z.boolean().optional() }),
);

const openListSchema = z.array(
  z.object({
    web_url: z.string(),
    iid: z.int(),
    project_id: z.int(),
    title: z.string(),
    source_branch: z.string(),
    target_branch: z.string(),
    sha: z.string().nullable(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    author,
    created_at: z.string(),
    detailed_merge_status: z.string().optional(),
    head_pipeline: pipelineSchema.nullable().optional(),
    pipeline: pipelineSchema.nullable().optional(),
  }),
);

const approvalsSchema = z.object({
  approved: z.boolean().optional(),
  approved_by: z.array(z.object({ user: author })).optional(),
});

type MergeRequestReply = z.infer<typeof mergeRequestSchema>;
type Pipeline = z.infer<typeof pipelineSchema>;
type ListedMergeRequest = z.infer<typeof openListSchema>[number];

export interface OpenMergeRequestReplies {
  mergeRequest: string | undefined;
  approvals: string;
}

export interface DiscussionThread {
  author: string | null;
  resolved: boolean;
}

export interface MergeRequestReplies {
  mergeRequest: string;
  project: string;
  discussions: string;
  jobs: string | undefined;
}

const MR_STATES: Record<MergeRequestReply['state'], PullRequestState> = {
  opened: 'open',
  locked: 'open',
  merged: 'merged',
  closed: 'closed',
};

const PIPELINE_STATES: Partial<Record<string, ChecksState>> = {
  success: 'passing',
  skipped: 'passing',
  failed: 'failing',
  canceled: 'failing',
};

const UNSETTLED_MERGE_STATUSES: readonly string[] = [
  'unchecked',
  'checking',
  'preparing',
  'approvals_syncing',
  'cannot_be_merged_recheck',
  'cannot_be_merged_rechecking',
];

const CONFLICTING_MERGE_STATUSES: readonly string[] = [
  'conflict',
  'need_rebase',
  'cannot_be_merged',
];

const readMergeable = (mr: MergeRequestReply): Mergeable => {
  const status = mr.detailed_merge_status ?? mr.merge_status ?? 'unchecked';
  if (mr.state === 'locked' || UNSETTLED_MERGE_STATUSES.includes(status))
    return 'unknown';
  if (mr.has_conflicts === true || CONFLICTING_MERGE_STATUSES.includes(status))
    return 'conflicting';
  return 'mergeable';
};

const pipelineState = (pipeline: Pipeline | null | undefined): ChecksState => {
  if (!pipeline) return 'none';
  return PIPELINE_STATES[pipeline.status] ?? 'pending';
};

const failingJobs = (jobs: string | undefined): string[] => {
  if (jobs === undefined) return [];
  return jobsSchema
    .parse(JSON.parse(jobs))
    .filter((job) => job.allow_failure !== true)
    .map((job) => job.name);
};

export const readThreads = (json: string): DiscussionThread[] =>
  discussionsSchema
    .parse(JSON.parse(json))
    .map(({ notes }) => notes.filter((note) => note.system !== true))
    .filter((notes) => notes.length > 0)
    .map((notes) => ({
      author: notes[0]?.author?.username ?? null,
      resolved: !notes.some(
        (note) => note.resolvable === true && note.resolved !== true,
      ),
    }));

const authorOf = (thread: DiscussionThread): string | undefined =>
  thread.author ?? undefined;

export const readBotReview = (threads: DiscussionThread[]): BotReview => ({
  reviewers: [
    ...new Set(threads.map(authorOf).filter((login) => login !== undefined)),
  ],
  openThreads: threads
    .filter((thread) => !thread.resolved)
    .map(authorOf)
    .filter((login) => login !== undefined),
});

const readRepository = (url: string, json: string): RepositoryRef => {
  const project = projectSchema.parse(JSON.parse(json));
  const slash = project.path_with_namespace.lastIndexOf('/');
  const hostname = URL.parse(project.web_url)?.hostname;
  if (slash <= 0 || !hostname)
    throw new Error(`GitLab named an unreadable project for ${url}`);
  return {
    hostname: hostname.toLowerCase(),
    owner: project.path_with_namespace.slice(0, slash),
    name: project.path_with_namespace.slice(slash + 1),
  };
};

const readDefaultBranch = (json: string): string | null =>
  projectSchema.parse(JSON.parse(json)).default_branch ?? null;

export const parseMergeRequestReply = (json: string): MergeRequestReply =>
  mergeRequestSchema.parse(JSON.parse(json));

export const parseMergeRequest = (
  url: string,
  replies: MergeRequestReplies,
): PullRequest => {
  const mr = parseMergeRequestReply(replies.mergeRequest);
  return {
    repository: readRepository(url, replies.project),
    base: mr.target_branch,
    defaultBranch: readDefaultBranch(replies.project),
    state: MR_STATES[mr.state],
    head: mr.sha ?? '',
    draft: mr.draft ?? mr.work_in_progress ?? false,
    mergeable: readMergeable(mr),
    checks: {
      state: pipelineState(mr.head_pipeline),
      failing: failingJobs(replies.jobs),
    },
    botReview: readBotReview(readThreads(replies.discussions)),
  };
};

const listedPipeline = (
  mr: ListedMergeRequest,
): Pipeline | null | undefined => {
  if (mr.head_pipeline !== undefined) return mr.head_pipeline;
  return mr.pipeline;
};

const openChecks = (
  mr: ListedMergeRequest,
  replies: OpenMergeRequestReplies | undefined,
): ChecksState => {
  const listed = listedPipeline(mr);
  if (listed !== undefined || replies?.mergeRequest === undefined)
    return pipelineState(listed);
  return pipelineState(
    parseMergeRequestReply(replies.mergeRequest).head_pipeline,
  );
};

const isApproved = (json: string): boolean => {
  const approvals = approvalsSchema.parse(JSON.parse(json));
  return (
    approvals.approved !== false && (approvals.approved_by?.length ?? 0) > 0
  );
};

const openReview = (
  mr: ListedMergeRequest,
  replies: OpenMergeRequestReplies | undefined,
): ReviewState => {
  if (mr.detailed_merge_status === 'requested_changes') return 'changes';
  if (replies !== undefined && isApproved(replies.approvals)) return 'approved';
  return 'none';
};

export const parseOpenMergeRequests = (
  json: string,
  replies: ReadonlyMap<number, OpenMergeRequestReplies> = new Map(),
): OpenPullRequest[] =>
  openListSchema.parse(JSON.parse(json)).map((mr) => ({
    url: mr.web_url,
    number: mr.iid,
    title: mr.title,
    branch: mr.source_branch,
    base: mr.target_branch,
    head: mr.sha ?? '',
    draft: mr.draft ?? mr.work_in_progress ?? false,
    author: mr.author?.username ?? null,
    checks: openChecks(mr, replies.get(mr.iid)),
    review: openReview(mr, replies.get(mr.iid)),
    createdAt: mr.created_at,
  }));

export const runGlab: GlabRunner = async (args) => {
  try {
    const { stdout } = await exec('glab', args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    throw execError(`glab ${args.slice(0, 4).join(' ')}`, err);
  }
};

export const mergeRequestArgs = (url: string): string[] => {
  const ref = parseMergeRequestUrl(url);
  return glabApi(ref.hostname, mergeRequestEndpoint(ref));
};

export const projectArgs = (hostname: string, projectId: number): string[] =>
  glabApi(hostname, `projects/${projectId}`);

export const discussionsArgs = (
  hostname: string,
  projectId: number,
  iid: number,
): string[] =>
  glabApi(
    hostname,
    `projects/${projectId}/merge_requests/${iid}/discussions?per_page=${GITLAB_PAGE_SIZE}`,
  );

export const failedJobsArgs = (
  hostname: string,
  projectId: number,
  pipelineId: number,
): string[] =>
  glabApi(
    hostname,
    `projects/${projectId}/pipelines/${pipelineId}/jobs?scope[]=failed&scope[]=canceled&per_page=${GITLAB_PAGE_SIZE}`,
  );

export const glabSquashMergeArgs = (url: string, head: string): string[] => {
  const ref = parseMergeRequestUrl(url);
  return [
    'api',
    '--hostname',
    ref.hostname,
    '--method',
    'PUT',
    `${mergeRequestEndpoint(ref)}/merge`,
    '-F',
    'squash=true',
    '-f',
    `sha=${head}`,
  ];
};

export const glabListOpenArgs = (repository: RepositoryRef): string[] =>
  glabApi(
    repository.hostname,
    `projects/${projectPath(repository)}/merge_requests?state=opened&per_page=${GITLAB_PAGE_SIZE}`,
  );

export const GITLAB_OPEN_BATCH = 8;

export const approvalsArgs = (
  hostname: string,
  projectId: number,
  iid: number,
): string[] =>
  glabApi(hostname, `projects/${projectId}/merge_requests/${iid}/approvals`);

export const listedMergeRequestArgs = (
  hostname: string,
  projectId: number,
  iid: number,
): string[] => glabApi(hostname, `projects/${projectId}/merge_requests/${iid}`);

const inBatches = async <T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> => {
  const done: R[] = [];
  for (let at = 0; at < items.length; at += size)
    done.push(...(await Promise.all(items.slice(at, at + size).map(work))));
  return done;
};

const readListedPipeline = async (
  run: GlabRunner,
  hostname: string,
  mr: ListedMergeRequest,
): Promise<string | undefined> => {
  if (listedPipeline(mr) !== undefined) return undefined;
  return run(listedMergeRequestArgs(hostname, mr.project_id, mr.iid));
};

const readOpenReplies = async (
  run: GlabRunner,
  hostname: string,
  mr: ListedMergeRequest,
): Promise<[number, OpenMergeRequestReplies]> => {
  const [mergeRequest, approvals] = await Promise.all([
    readListedPipeline(run, hostname, mr),
    run(approvalsArgs(hostname, mr.project_id, mr.iid)),
  ]);
  return [mr.iid, { mergeRequest, approvals }];
};

const readOpenMergeRequests = async (
  run: GlabRunner,
  repository: RepositoryRef,
): Promise<OpenPullRequest[]> => {
  const list = await run(glabListOpenArgs(repository));
  const replies = await inBatches(
    openListSchema.parse(JSON.parse(list)),
    GITLAB_OPEN_BATCH,
    (mr) => readOpenReplies(run, repository.hostname, mr),
  );
  return parseOpenMergeRequests(list, new Map(replies));
};

const readJobs = async (
  run: GlabRunner,
  hostname: string,
  mr: MergeRequestReply,
): Promise<string | undefined> => {
  const pipeline = mr.head_pipeline;
  if (!pipeline || pipelineState(pipeline) !== 'failing') return undefined;
  return run(
    failedJobsArgs(hostname, pipeline.project_id ?? mr.project_id, pipeline.id),
  );
};

const readMergeRequest = async (
  run: GlabRunner,
  url: string,
): Promise<PullRequest> => {
  const { hostname } = parseMergeRequestUrl(url);
  const mergeRequest = await run(mergeRequestArgs(url));
  const mr = parseMergeRequestReply(mergeRequest);
  const [project, discussions, jobs] = await Promise.all([
    run(projectArgs(hostname, mr.project_id)),
    run(discussionsArgs(hostname, mr.project_id, mr.iid)),
    readJobs(run, hostname, mr),
  ]);
  return parseMergeRequest(url, { mergeRequest, project, discussions, jobs });
};

export const glabCli = (run: GlabRunner = runGlab): ForgeHost => ({
  forge: 'gitlab',
  pullRequestRef: parseMergeRequestUrl,
  pullRequest: (url) => readMergeRequest(run, url),
  squashMerge: async (url, head) => {
    await run(glabSquashMergeArgs(url, head));
  },
  listOpen: (repository) => readOpenMergeRequests(run, repository),
});
