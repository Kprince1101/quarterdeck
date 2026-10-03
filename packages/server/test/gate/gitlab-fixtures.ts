import type { GlabRunner } from '../../src/gate/index.js';

export const GITLAB_HEAD = '89abcdef0123456789abcdef0123456789abcdef';
export const GITLAB_PROJECT_ID = 412;
export const GITLAB_PIPELINE_ID = 99120;
export const GITLAB_MR =
  'https://git.example.org/example-group/platform/quarterdeck/-/merge_requests/23';

const person = (id: number, username: string) => ({
  id,
  username,
  name: username,
  state: 'active',
  locked: false,
  avatar_url: null,
  web_url: `https://git.example.org/${username}`,
});

export const DUO = person(7, 'GitLabDuo');
export const FINCH = person(31, 'finch');
export const OKAPI = person(32, 'okapi');

export type GitlabPerson = ReturnType<typeof person>;

const RECORDED_PIPELINE = {
  id: GITLAB_PIPELINE_ID,
  iid: 311,
  project_id: GITLAB_PROJECT_ID,
  sha: GITLAB_HEAD,
  ref: 'refs/merge-requests/23/head',
  status: 'success',
  source: 'merge_request_event',
  created_at: '2026-10-02T14:03:11.204Z',
  updated_at: '2026-10-02T14:09:47.881Z',
  web_url: `https://git.example.org/example-group/platform/quarterdeck/-/pipelines/${GITLAB_PIPELINE_ID}`,
  before_sha: '0000000000000000000000000000000000000000',
  tag: false,
  yaml_errors: null,
  user: FINCH,
  started_at: '2026-10-02T14:03:13.010Z',
  finished_at: '2026-10-02T14:09:47.862Z',
  committed_at: null,
  duration: 394,
  queued_duration: 1,
  coverage: null,
  detailed_status: {
    icon: 'status_success',
    text: 'Passed',
    label: 'passed',
    group: 'success',
    tooltip: 'passed',
    has_details: true,
    details_path: `/example-group/platform/quarterdeck/-/pipelines/${GITLAB_PIPELINE_ID}`,
    illustration: null,
    favicon: '/assets/ci_favicons/favicon_status_success.png',
  },
};

const RECORDED_MERGE_REQUEST = {
  id: 84512,
  iid: 23,
  project_id: GITLAB_PROJECT_ID,
  title: 'Add a GitLab forge on glab',
  description: 'Reads merge requests through glab api.',
  state: 'opened',
  created_at: '2026-10-02T13:58:40.117Z',
  updated_at: '2026-10-02T14:10:02.540Z',
  merged_by: null,
  merge_user: null,
  merged_at: null,
  closed_by: null,
  closed_at: null,
  target_branch: 'main',
  source_branch: 'qd20-gitlab-forge',
  user_notes_count: 3,
  upvotes: 0,
  downvotes: 0,
  author: FINCH,
  assignees: [],
  assignee: null,
  reviewers: [OKAPI],
  source_project_id: GITLAB_PROJECT_ID,
  target_project_id: GITLAB_PROJECT_ID,
  labels: [],
  draft: false,
  imported: false,
  imported_from: 'none',
  work_in_progress: false,
  milestone: null,
  merge_when_pipeline_succeeds: false,
  merge_status: 'can_be_merged',
  detailed_merge_status: 'mergeable',
  merge_after: null,
  sha: GITLAB_HEAD,
  merge_commit_sha: null,
  squash_commit_sha: null,
  discussion_locked: null,
  should_remove_source_branch: null,
  force_remove_source_branch: true,
  prepared_at: '2026-10-02T13:58:44.902Z',
  reference: '!23',
  references: {
    short: '!23',
    relative: '!23',
    full: 'example-group/platform/quarterdeck!23',
  },
  web_url: GITLAB_MR,
  time_stats: {
    time_estimate: 0,
    total_time_spent: 0,
    human_time_estimate: null,
    human_total_time_spent: null,
  },
  squash: true,
  squash_on_merge: true,
  task_completion_status: { count: 0, completed_count: 0 },
  has_conflicts: false,
  blocking_discussions_resolved: true,
  approvals_before_merge: null,
  subscribed: false,
  changes_count: '6',
  latest_build_started_at: '2026-10-02T14:03:13.010Z',
  latest_build_finished_at: '2026-10-02T14:09:47.862Z',
  first_deployed_to_production_at: null,
  pipeline: RECORDED_PIPELINE,
  head_pipeline: RECORDED_PIPELINE,
  diff_refs: {
    base_sha: 'fedcba9876543210fedcba9876543210fedcba98',
    head_sha: GITLAB_HEAD,
    start_sha: 'fedcba9876543210fedcba9876543210fedcba98',
  },
  merge_error: null,
  first_contribution: false,
  user: { can_merge: true },
};

const RECORDED_PROJECT = {
  id: GITLAB_PROJECT_ID,
  description: 'Quarterdeck, self-hosted.',
  name: 'quarterdeck',
  name_with_namespace: 'example-group / platform / quarterdeck',
  path: 'quarterdeck',
  path_with_namespace: 'example-group/platform/quarterdeck',
  created_at: '2026-06-11T08:20:31.554Z',
  default_branch: 'main',
  tag_list: [],
  topics: [],
  ssh_url_to_repo: 'git@git.example.org:example-group/platform/quarterdeck.git',
  http_url_to_repo:
    'https://git.example.org/example-group/platform/quarterdeck.git',
  web_url: 'https://git.example.org/example-group/platform/quarterdeck',
  readme_url:
    'https://git.example.org/example-group/platform/quarterdeck/-/blob/main/README.md',
  forks_count: 0,
  star_count: 2,
  last_activity_at: '2026-10-02T14:10:02.540Z',
  namespace: {
    id: 58,
    name: 'platform',
    path: 'platform',
    kind: 'group',
    full_path: 'example-group/platform',
    parent_id: 57,
    web_url: 'https://git.example.org/groups/example-group/platform',
  },
  visibility: 'private',
  squash_option: 'default_on',
  merge_method: 'merge',
  only_allow_merge_if_pipeline_succeeds: true,
  only_allow_merge_if_all_discussions_are_resolved: false,
};

const RECORDED_JOB = {
  id: 551203,
  status: 'failed',
  stage: 'test',
  name: 'validate',
  ref: 'refs/merge-requests/23/head',
  tag: false,
  coverage: null,
  allow_failure: false,
  created_at: '2026-10-02T14:03:11.330Z',
  started_at: '2026-10-02T14:03:20.115Z',
  finished_at: '2026-10-02T14:07:52.904Z',
  erased_at: null,
  duration: 272.789,
  queued_duration: 6.215,
  user: FINCH,
  commit: { id: GITLAB_HEAD, short_id: GITLAB_HEAD.slice(0, 8) },
  pipeline: {
    id: GITLAB_PIPELINE_ID,
    project_id: GITLAB_PROJECT_ID,
    sha: GITLAB_HEAD,
    ref: 'refs/merge-requests/23/head',
    status: 'failed',
  },
  failure_reason: 'script_failure',
  web_url: `https://git.example.org/example-group/platform/quarterdeck/-/jobs/551203`,
  artifacts: [],
  runner: null,
  tag_list: ['docker'],
};

let noteId = 9000;

const note = (
  author: GitlabPerson,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  noteId += 1;
  return {
    id: noteId,
    type: 'DiffNote',
    body: 'Consider handling a null sha here.',
    attachment: null,
    author,
    created_at: '2026-10-02T14:12:30.008Z',
    updated_at: '2026-10-02T14:12:30.008Z',
    system: false,
    noteable_id: 84512,
    noteable_type: 'MergeRequest',
    project_id: GITLAB_PROJECT_ID,
    resolvable: true,
    resolved: false,
    resolved_by: null,
    resolved_at: null,
    confidential: false,
    internal: false,
    noteable_iid: 23,
    commands_changes: {},
    ...extra,
  };
};

export interface GitlabThread {
  author: GitlabPerson;
  resolved?: boolean;
  resolvable?: boolean;
  replies?: GitlabPerson[];
}

const discussion = (thread: GitlabThread) => {
  const resolvable = thread.resolvable ?? true;
  const resolved = resolvable && (thread.resolved ?? false);
  const notes = [thread.author, ...(thread.replies ?? [])].map((who) =>
    note(who, { resolvable, resolved }),
  );
  return {
    id: `d${noteId}`,
    individual_note: !resolvable,
    notes,
  };
};

const SYSTEM_DISCUSSION = {
  id: 'dsystem',
  individual_note: true,
  notes: [
    note(FINCH, {
      type: null,
      body: 'added 1 commit',
      system: true,
      resolvable: false,
    }),
  ],
};

export interface GitlabShape {
  mergeRequest?: Record<string, unknown>;
  pipeline?: Record<string, unknown> | null;
  project?: Record<string, unknown>;
  threads?: GitlabThread[];
  jobs?: Record<string, unknown>[];
}

const pipelineOf = (shape: GitlabShape): unknown => {
  if (shape.pipeline === null) return null;
  return { ...RECORDED_PIPELINE, ...shape.pipeline };
};

export const gitlabMergeRequest = (shape: GitlabShape = {}): string =>
  JSON.stringify({
    ...RECORDED_MERGE_REQUEST,
    head_pipeline: pipelineOf(shape),
    pipeline: pipelineOf(shape),
    ...shape.mergeRequest,
  });

export const gitlabProject = (shape: GitlabShape = {}): string =>
  JSON.stringify({ ...RECORDED_PROJECT, ...shape.project });

export const gitlabDiscussions = (shape: GitlabShape = {}): string =>
  JSON.stringify([SYSTEM_DISCUSSION, ...(shape.threads ?? []).map(discussion)]);

export const gitlabJob = (
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ ...RECORDED_JOB, name, ...extra });

export const gitlabJobs = (shape: GitlabShape = {}): string =>
  JSON.stringify(shape.jobs ?? []);

export const gitlabOpenList = (
  mergeRequests: Record<string, unknown>[],
): string =>
  JSON.stringify(
    mergeRequests.map((extra) => ({
      ...RECORDED_MERGE_REQUEST,
      head_pipeline: undefined,
      pipeline: undefined,
      ...extra,
    })),
  );

const endpointOf = (args: string[]): string => {
  const endpoint = args.find((arg) => arg.startsWith('projects/'));
  if (endpoint === undefined)
    throw new Error(`no endpoint in glab ${args.join(' ')}`);
  return endpoint;
};

const isMerge = (args: string[]): boolean => args.includes('PUT');

const answerFor = (shape: GitlabShape, endpoint: string): string => {
  if (endpoint.includes('/discussions')) return gitlabDiscussions(shape);
  if (endpoint.includes('/jobs')) return gitlabJobs(shape);
  if (endpoint.includes('/merge_requests/')) return gitlabMergeRequest(shape);
  if (endpoint === `projects/${GITLAB_PROJECT_ID}`) return gitlabProject(shape);
  throw new Error(`no recorded reply for ${endpoint}`);
};

export const glabAnswers =
  (shape: () => GitlabShape, calls: string[][] = []): GlabRunner =>
  async (args) => {
    calls.push(args);
    if (isMerge(args)) return '{}';
    return answerFor(shape(), endpointOf(args));
  };
