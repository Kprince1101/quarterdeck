import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { forgeTerms, loadRule, type MergeGate } from '@quarterdeck/rules';
import { describe, expect, it } from 'vitest';
import {
  GITLAB_PAGE_SIZE,
  foreignPullRequest,
  forgeHost,
  glabCli,
  mergeStep,
  parseMergeRequest,
  parseMergeRequestUrl,
  readBotReview,
  readThreads,
  type Approval,
  type GlabRunner,
  type RepositoryRef,
} from '../../src/gate/index.js';
import {
  FINCH,
  REVIEW_BOT,
  GITLAB_HEAD as HEAD,
  GITLAB_MR as MR,
  GITLAB_PIPELINE_ID,
  GITLAB_PROJECT_ID,
  OKAPI,
  gitlabApprovals,
  gitlabDiscussions,
  gitlabJob,
  gitlabJobs,
  gitlabMergeRequest,
  gitlabOpenList,
  gitlabProject,
  glabAnswers,
  type GitlabShape,
} from './gitlab-fixtures.ts';

const HOST = 'git.example.org';
const PROJECT: RepositoryRef = {
  hostname: HOST,
  owner: 'example-group/platform',
  name: 'quarterdeck',
};
const ENCODED = 'example-group%2Fplatform%2Fquarterdeck';

const parse = (shape: GitlabShape = {}) =>
  parseMergeRequest(MR, {
    mergeRequest: gitlabMergeRequest(shape),
    project: gitlabProject(shape),
    discussions: gitlabDiscussions(shape),
    jobs: shape.jobs && gitlabJobs(shape),
  });

const failedPipeline = (status = 'failed'): GitlabShape => ({
  pipeline: { status },
  mergeRequest: { detailed_merge_status: 'ci_must_pass' },
});

describe('glab merge request URL', () => {
  it('parses a merge request in a nested group', () => {
    expect(parseMergeRequestUrl(MR)).toEqual({ ...PROJECT, number: 23 });
    expect(
      parseMergeRequestUrl(
        'https://Git.Example.org/example-group/a/b/c/deck/-/merge_requests/7/',
      ),
    ).toEqual({
      hostname: HOST,
      owner: 'example-group/a/b/c',
      name: 'deck',
      number: 7,
    });
    expect(
      parseMergeRequestUrl(
        'https://gitlab.com/example-group/deck/-/merge_requests/1',
      ),
    ).toEqual({
      hostname: 'gitlab.com',
      owner: 'example-group',
      name: 'deck',
      number: 1,
    });
  });

  it('refuses a URL that is not a merge request', () => {
    for (const url of [
      'https://git.example.org/example-group/platform/quarterdeck/-/issues/23',
      'https://git.example.org/example-group/platform/quarterdeck/merge_requests/23',
      'https://git.example.org/deck/-/merge_requests/23',
      'https://git.example.org/example-group/-/deck/-/merge_requests/23',
      'https://git.example.org/example-group/deck/-/merge_requests/23/diffs',
      'https://github.com/example-org/quarterdeck/pull/23',
      'not a url',
    ])
      expect(() => parseMergeRequestUrl(url)).toThrow(
        'is not a GitLab merge request URL',
      );
  });

  it('bounces a merge request from another project before glab is asked', () => {
    const terms = forgeTerms('gitlab');
    const foreign =
      'https://git.example.org/mallory/payroll/-/merge_requests/9';
    const sibling =
      'https://git.example.org/example-group/quarterdeck/-/merge_requests/23';

    expect(
      foreignPullRequest(MR, PROJECT, terms, parseMergeRequestUrl),
    ).toBeUndefined();
    for (const url of [foreign, sibling])
      expect(
        foreignPullRequest(url, PROJECT, terms, parseMergeRequestUrl),
      ).toBe(
        `the merge request ${url} is not in this project's repository git.example.org/example-group/platform/quarterdeck; open it there and report again`,
      );
  });
});

describe('glab merge request', () => {
  it('reads an open, mergeable merge request with a passing pipeline', () => {
    expect(parse()).toEqual({
      repository: PROJECT,
      base: 'main',
      defaultBranch: 'main',
      state: 'open',
      head: HEAD,
      draft: false,
      mergeable: 'mergeable',
      checks: { state: 'passing', failing: [] },
      botReview: { reviewers: [], openThreads: [] },
    });
  });

  it('maps merged and closed', () => {
    const settled = (state: string) => ({
      mergeRequest: { state, detailed_merge_status: 'not_open' },
    });

    expect(parse(settled('merged')).state).toBe('merged');
    expect(parse(settled('closed')).state).toBe('closed');
  });

  it('reads a draft, and the older work_in_progress flag', () => {
    expect(
      parse({
        mergeRequest: { draft: true, detailed_merge_status: 'draft_status' },
      }),
    ).toMatchObject({ draft: true, mergeable: 'mergeable' });
    expect(
      parse({ mergeRequest: { draft: undefined, work_in_progress: true } })
        .draft,
    ).toBe(true);
  });

  it('reads conflicts, a needed rebase and a merge status still being worked out', () => {
    const mergeable = (mergeRequest: Record<string, unknown>) =>
      parse({ mergeRequest }).mergeable;

    expect(
      mergeable({ has_conflicts: true, detailed_merge_status: 'conflict' }),
    ).toBe('conflicting');
    expect(mergeable({ detailed_merge_status: 'need_rebase' })).toBe(
      'conflicting',
    );
    expect(mergeable({ detailed_merge_status: 'checking' })).toBe('unknown');
    expect(mergeable({ detailed_merge_status: 'unchecked' })).toBe('unknown');
    expect(mergeable({ state: 'locked' })).toBe('unknown');
    expect(
      mergeable({
        detailed_merge_status: undefined,
        merge_status: 'cannot_be_merged',
      }),
    ).toBe('conflicting');
    expect(
      mergeable({ detailed_merge_status: undefined, merge_status: undefined }),
    ).toBe('unknown');
  });

  it('counts a merge request blocked only by its own pipeline as mergeable', () => {
    expect(parse(failedPipeline()).mergeable).toBe('mergeable');
    expect(
      parse({ mergeRequest: { detailed_merge_status: 'ci_still_running' } })
        .mergeable,
    ).toBe('mergeable');
  });

  it('names the failing jobs, leaving out ones allowed to fail', () => {
    const pr = parse({
      ...failedPipeline(),
      jobs: [
        gitlabJob('validate'),
        gitlabJob('lint:advisory', { allow_failure: true }),
        gitlabJob('e2e', { status: 'canceled' }),
      ],
    });

    expect(pr.checks).toEqual({
      state: 'failing',
      failing: ['validate', 'e2e'],
    });
  });

  it('reads a canceled pipeline as failing', () => {
    expect(parse({ ...failedPipeline('canceled'), jobs: [] }).checks).toEqual({
      state: 'failing',
      failing: [],
    });
  });

  it('reads a pipeline still running as pending', () => {
    for (const status of [
      'created',
      'waiting_for_resource',
      'preparing',
      'pending',
      'running',
      'manual',
      'scheduled',
    ])
      expect(parse({ pipeline: { status } }).checks).toEqual({
        state: 'pending',
        failing: [],
      });
  });

  it('reads no pipeline as no checks and a skipped one as passing', () => {
    expect(parse({ pipeline: null }).checks.state).toBe('none');
    expect(parse({ pipeline: { status: 'skipped' } }).checks.state).toBe(
      'passing',
    );
  });

  it('reads the project, target branch and default branch GitLab reports', () => {
    const pr = parse({
      mergeRequest: { target_branch: 'release/1.0' },
      project: {
        path_with_namespace: 'Example-Group/Platform/Quarterdeck',
        web_url: 'https://GIT.example.org/Example-Group/Platform/Quarterdeck',
        default_branch: null,
      },
    });

    expect(pr.repository).toEqual({
      hostname: HOST,
      owner: 'Example-Group/Platform',
      name: 'Quarterdeck',
    });
    expect(pr.base).toBe('release/1.0');
    expect(pr.defaultBranch).toBeNull();
  });

  it('throws on a project it cannot place', () => {
    expect(() =>
      parse({ project: { path_with_namespace: 'quarterdeck' } }),
    ).toThrow(`GitLab named an unreadable project for ${MR}`);
  });
});

describe('glab discussions', () => {
  const threads: GitlabShape = {
    threads: [
      { author: REVIEW_BOT },
      { author: REVIEW_BOT, replies: [FINCH] },
      { author: REVIEW_BOT, resolved: true },
      { author: REVIEW_BOT, resolvable: false },
      { author: OKAPI },
      { author: OKAPI, resolved: true },
      { author: FINCH, resolvable: false },
    ],
  };

  it('reads each discussion as the author who opened it and whether it is open, skipping system notes', () => {
    const read = readThreads(gitlabDiscussions(threads));

    expect(read).toEqual([
      { author: 'review-bot', resolved: false },
      { author: 'review-bot', resolved: false },
      { author: 'review-bot', resolved: true },
      { author: 'review-bot', resolved: true },
      { author: 'okapi', resolved: false },
      { author: 'okapi', resolved: true },
      { author: 'finch', resolved: true },
    ]);
  });

  it('reports every discussion author and who opened each open thread, leaving the choice of bot to the gate', () => {
    expect(parse(threads).botReview).toEqual({
      reviewers: ['review-bot', 'okapi', 'finch'],
      openThreads: ['review-bot', 'review-bot', 'okapi'],
    });
    expect(parse({ threads: [] }).botReview).toEqual({
      reviewers: [],
      openThreads: [],
    });
    expect(readBotReview([{ author: null, resolved: false }])).toEqual({
      reviewers: [],
      openThreads: [],
    });
  });
});

describe('AI review on a GitLab merge request', () => {
  const APPROVAL: Approval = {
    eventId: 1,
    reportId: 1,
    pr: MR,
    head: HEAD,
    cardId: undefined,
  };

  const stepFor = async (shape: GitlabShape, rules: MergeGate) =>
    mergeStep(
      APPROVAL,
      await glabCli(glabAnswers(() => shape)).pullRequest(MR),
      'none',
      rules,
      PROJECT,
      'gitlab',
    );

  const shipped = async (): Promise<MergeGate> => {
    const home = await mkdtemp(resolve(tmpdir(), 'qd-gitlab-ai-'));
    try {
      return (await loadRule('lifecycle', { homeDir: home })).mergeGate;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };

  it('waits for a configured bot login, bounces its open thread, then passes', async () => {
    const gate = await shipped();
    const rules: MergeGate = {
      ...gate,
      autoMerge: true,
      requireAiReview: true,
      aiReviewers: { ...gate.aiReviewers, gitlab: ['review-bot'] },
    };

    expect(await stepFor({ threads: [{ author: OKAPI }] }, rules)).toEqual({
      kind: 'wait',
      reason: 'waiting for an AI review from review-bot',
    });
    expect(
      await stepFor(
        { threads: [{ author: REVIEW_BOT, replies: [FINCH] }] },
        rules,
      ),
    ).toEqual({
      kind: 'bounce',
      reason:
        '1 AI review thread(s) from review-bot are unresolved on the merge request; answer and resolve each, then report again',
    });
    expect(
      await stepFor(
        {
          threads: [{ author: REVIEW_BOT, resolved: true }, { author: OKAPI }],
        },
        rules,
      ),
    ).toEqual({ kind: 'merge' });
  });

  it('is a config error with the shipped empty GitLab list', async () => {
    const rules: MergeGate = { ...(await shipped()), requireAiReview: true };

    expect(rules.aiReviewers.gitlab).toEqual([]);
    await expect(
      stepFor({ threads: [{ author: REVIEW_BOT, resolved: true }] }, rules),
    ).rejects.toThrow(
      '~/.quarterdeck/rules.local.lifecycle.json: mergeGate.requireAiReview is on, but mergeGate.aiReviewers.gitlab lists no GitLab bot logins',
    );
  });
});

describe('glab host', () => {
  const recording = (shape: GitlabShape = {}) => {
    const calls: string[][] = [];
    return { calls, host: glabCli(glabAnswers(() => shape, calls)) };
  };

  it('is the gitlab forge, and forgeHost puts GitLab on it', () => {
    expect(glabCli(async () => '').forge).toBe('gitlab');
    expect(forgeHost('gitlab').forge).toBe('gitlab');
    expect(forgeHost('gitlab').pullRequestRef(MR)).toEqual({
      ...PROJECT,
      number: 23,
    });
  });

  it('reads the merge request, its project and its discussions from the merge request host', async () => {
    const { calls, host } = recording();

    expect(await host.pullRequest(MR)).toEqual(parse());
    expect(calls).toEqual([
      ['api', '--hostname', HOST, `projects/${ENCODED}/merge_requests/23`],
      ['api', '--hostname', HOST, `projects/${GITLAB_PROJECT_ID}`],
      [
        'api',
        '--hostname',
        HOST,
        `projects/${GITLAB_PROJECT_ID}/merge_requests/23/discussions?per_page=${GITLAB_PAGE_SIZE}`,
      ],
    ]);
  });

  it('asks for the failed jobs only when the pipeline failed', async () => {
    const { calls, host } = recording({
      ...failedPipeline(),
      jobs: [gitlabJob('validate')],
    });

    expect((await host.pullRequest(MR)).checks).toEqual({
      state: 'failing',
      failing: ['validate'],
    });
    expect(calls.at(-1)).toEqual([
      'api',
      '--hostname',
      HOST,
      `projects/${GITLAB_PROJECT_ID}/pipelines/${GITLAB_PIPELINE_ID}/jobs?scope[]=failed&scope[]=canceled&per_page=${GITLAB_PAGE_SIZE}`,
    ]);
  });

  it('squash merges with the approved head as the sha guard', async () => {
    const { calls, host } = recording();

    await host.squashMerge(MR, HEAD);

    expect(calls).toEqual([
      [
        'api',
        '--hostname',
        HOST,
        '--method',
        'PUT',
        `projects/${ENCODED}/merge_requests/23/merge`,
        '-F',
        'squash=true',
        '-f',
        `sha=${HEAD}`,
      ],
    ]);
  });

  it('passes on the refusal glab gives when the head moved', async () => {
    const run: GlabRunner = async () => {
      throw new Error(
        'glab api --hostname git.example.org --method failed: 409 SHA does not match HEAD of source branch',
      );
    };

    await expect(glabCli(run).squashMerge(MR, HEAD)).rejects.toThrow(
      'SHA does not match HEAD of source branch',
    );
  });

  it('refuses to merge a URL that is not a merge request', async () => {
    const { calls, host } = recording();

    await expect(
      host.squashMerge(
        'https://github.com/example-org/quarterdeck/pull/23',
        HEAD,
      ),
    ).rejects.toThrow('is not a GitLab merge request URL');
    expect(calls).toEqual([]);
  });

  const DRAFT_MR =
    'https://git.example.org/example-group/platform/quarterdeck/-/merge_requests/24';

  interface OpenReplies {
    list: Record<string, unknown>[];
    details?: Record<number, GitlabShape>;
    approvals?: Record<number, string>;
  }

  const openRunner =
    (replies: OpenReplies, calls: string[][]): GlabRunner =>
    async (args) => {
      calls.push(args);
      const endpoint = args.at(-1) ?? '';
      if (endpoint.includes('state=opened'))
        return gitlabOpenList(replies.list);
      const iid = Number(/merge_requests\/(\d+)/.exec(endpoint)?.[1]);
      if (endpoint.endsWith('/approvals'))
        return replies.approvals?.[iid] ?? gitlabApprovals();
      return gitlabMergeRequest(replies.details?.[iid] ?? {});
    };

  it('lists the open merge requests of a project, with each one’s pipeline and approvals', async () => {
    const calls: string[][] = [];
    const run = openRunner(
      {
        list: [
          {},
          {
            iid: 24,
            title: 'Draft: widget',
            web_url: DRAFT_MR,
            source_branch: 'wip',
            target_branch: 'release',
            created_at: '2026-10-02T15:20:00.000Z',
            draft: true,
            author: null,
          },
        ],
        details: {
          23: { pipeline: { status: 'success' } },
          24: { pipeline: null, mergeRequest: { iid: 24 } },
        },
        approvals: { 23: gitlabApprovals([OKAPI]) },
      },
      calls,
    );

    const open = await glabCli(run).listOpen(PROJECT);

    const api = (endpoint: string) => ['api', '--hostname', HOST, endpoint];
    expect(calls).toEqual([
      api(
        `projects/${ENCODED}/merge_requests?state=opened&per_page=${GITLAB_PAGE_SIZE}`,
      ),
      api(`projects/${GITLAB_PROJECT_ID}/merge_requests/23`),
      api(`projects/${GITLAB_PROJECT_ID}/merge_requests/23/approvals`),
      api(`projects/${GITLAB_PROJECT_ID}/merge_requests/24`),
      api(`projects/${GITLAB_PROJECT_ID}/merge_requests/24/approvals`),
    ]);
    expect(open).toEqual([
      {
        url: MR,
        number: 23,
        title: 'Add a GitLab forge on glab',
        branch: 'qd20-gitlab-forge',
        base: 'main',
        head: HEAD,
        draft: false,
        author: 'finch',
        checks: 'passing',
        review: 'approved',
        createdAt: '2026-10-02T13:58:40.117Z',
      },
      {
        url: DRAFT_MR,
        number: 24,
        title: 'Draft: widget',
        branch: 'wip',
        base: 'release',
        head: HEAD,
        draft: true,
        author: null,
        checks: 'none',
        review: 'none',
        createdAt: '2026-10-02T15:20:00.000Z',
      },
    ]);
  });

  it('maps each open merge request’s pipeline through the same states as one merge request', async () => {
    const statuses = ['success', 'skipped', 'failed', 'canceled', 'running'];
    const run = openRunner(
      {
        list: statuses.map((_status, at) => ({ iid: 30 + at })),
        details: Object.fromEntries(
          statuses.map((status, at) => [
            30 + at,
            { pipeline: { status }, mergeRequest: { iid: 30 + at } },
          ]),
        ),
      },
      [],
    );

    const open = await glabCli(run).listOpen(PROJECT);

    expect(open.map(({ checks }) => checks)).toEqual([
      'passing',
      'passing',
      'failing',
      'failing',
      'pending',
    ]);
  });

  it('uses a pipeline the list already carries, and reads changes requested from the merge status', async () => {
    const calls: string[][] = [];
    const run = openRunner(
      {
        list: [
          {
            head_pipeline: { id: GITLAB_PIPELINE_ID, status: 'running' },
            detailed_merge_status: 'requested_changes',
          },
          {
            iid: 24,
            web_url: DRAFT_MR,
            head_pipeline: null,
            pipeline: { id: GITLAB_PIPELINE_ID, status: 'failed' },
          },
        ],
        approvals: {
          23: gitlabApprovals([OKAPI]),
          24: gitlabApprovals([OKAPI], { approved: false, approvals_left: 1 }),
        },
      },
      calls,
    );

    const open = await glabCli(run).listOpen(PROJECT);

    expect(calls.map((args) => args.at(-1))).not.toContain(
      `projects/${GITLAB_PROJECT_ID}/merge_requests/23`,
    );
    expect(calls).toHaveLength(3);
    expect(open.map(({ checks, review }) => [checks, review])).toEqual([
      ['pending', 'changes'],
      ['none', 'none'],
    ]);
  });
});
