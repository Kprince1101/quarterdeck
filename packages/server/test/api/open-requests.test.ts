import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Forge } from '@quarterdeck/rules';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOpenRequests, linkTicket } from '../../src/api/index.js';
import {
  glabCli,
  type ForgeHost,
  type GlabRunner,
  type OpenPullRequest,
} from '../../src/gate/index.js';
import { forgeRequestsResultSchema } from '../../src/intents/index.js';
import {
  OKAPI,
  gitlabApprovals,
  gitlabMergeRequest,
  gitlabOpenList,
} from '../gate/gitlab-fixtures.ts';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const exec = promisify(execFile);

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const EXAMPLE_PR = 'https://github.com/example-org/example/pull/7';
const SAMPLE_MR = 'https://gitlab.com/example-org/sample/-/merge_requests/3';

const listed = (
  request: Pick<OpenPullRequest, 'url' | 'number'> & Partial<OpenPullRequest>,
): OpenPullRequest => ({
  title: 'A change',
  branch: 'topic',
  base: 'main',
  head: HEAD,
  draft: false,
  author: 'okapi',
  checks: 'passing',
  review: 'none',
  createdAt: '2026-10-01T09:00:00.000Z',
  ...request,
});

const notUsed = (): never => {
  throw new Error('not used by the dashboard read');
};

describe('forge.requests', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  const repos: string[] = [];
  const lists = new Map<string, OpenPullRequest[] | Error>();
  const calls: string[] = [];

  const host = (forge: Forge): ForgeHost => ({
    forge,
    pullRequestRef: notUsed,
    pullRequest: notUsed,
    squashMerge: notUsed,
    listOpen: async (repository) => {
      calls.push(`${forge}:${repository.owner}/${repository.name}`);
      const list = lists.get(repository.name) ?? [];
      if (list instanceof Error) throw list;
      return list;
    },
  });

  const repoWithOrigin = async (origin: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'qd-requests-repo-'));
    repos.push(dir);
    await exec('git', ['init', '-q', dir]);
    await exec('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
    return dir;
  };

  const createProject = async (project: string, origin: string | null) => {
    const input: { project: string; repoPath?: string } = { project };
    if (origin !== null) input.repoPath = await repoWithOrigin(origin);
    const res = await t.send('project.create', input);
    expect(res.status).toBe(200);
  };

  const createTicket = async (project: string, title: string) => {
    const res = await t.send('ticket.create', { project, title });
    return (res.body['result'] as { ticketId: string }).ticketId;
  };

  const assign = async (
    project: string,
    ticketId: string,
    agent: string,
    prUrl: string | null,
  ) => {
    const store = await t.store(project);
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role) values ($1, $2, 'builder')
       returning id`,
      [store.projectId, agent],
    );
    await store.db.query(
      'update tickets set assignee_id = $2, pr_url = $3 where id = $1',
      [ticketId, rows[0]?.id, prUrl],
    );
    return rows[0]?.id;
  };

  const read = async () => {
    const res = await t.send('forge.requests', {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent: 'forge.requests',
      status: 'applied',
      id: null,
    });
    return forgeRequestsResultSchema.parse(res.body['result']).projects;
  };

  beforeAll(async () => {
    t = await startTestApi([], undefined, {
      openRequests: { hosts: host, refreshMs: 0 },
    });
    await createProject('example', 'git@github.com:example-org/example.git');
    await createProject('sample', 'https://gitlab.com/example-org/sample.git');
    await createProject('no-repo', null);
    await createProject('shelved', 'git@github.com:example-org/shelved.git');
    await t.send('project.archive', { project: 'shelved', archived: true });
  }, 4 * TIMEOUT);

  beforeEach(() => {
    lists.clear();
    calls.length = 0;
  });

  afterAll(async () => {
    await t.close();
    await Promise.all(
      repos.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('lists every active project’s open requests on its own forge, linked to tickets and agents', async () => {
    const reported = await createTicket('example', 'Add the berth map');
    const branched = await createTicket('sample', 'Fix the tide table');
    const reporter = await assign('example', reported, 'gannet', EXAMPLE_PR);
    await assign('sample', branched, 'finch', null);
    lists.set('example', [
      listed({ url: EXAMPLE_PR, number: 7, title: 'Add the berth map' }),
      listed({
        url: 'https://github.com/example-org/example/pull/8',
        number: 8,
        branch: 'someone-else',
        draft: true,
        author: null,
        checks: 'failing',
        review: 'changes',
      }),
    ]);
    lists.set('sample', [
      listed({
        url: SAMPLE_MR,
        number: 3,
        branch: `finch-${branched.slice(0, 8)}`,
        base: 'develop',
        checks: 'pending',
        review: 'approved',
      }),
    ]);

    const projects = await read();

    expect(calls.toSorted()).toEqual([
      'github:example-org/example',
      'gitlab:example-org/sample',
    ]);
    expect(
      projects.map(({ project, forge, error }) => [project, forge, error]),
    ).toEqual([
      ['example', 'github', null],
      ['sample', 'gitlab', null],
    ]);
    const [example, sample] = projects;
    expect(example?.requests).toEqual([
      {
        url: EXAMPLE_PR,
        number: 7,
        title: 'Add the berth map',
        author: 'okapi',
        branch: 'topic',
        base: 'main',
        draft: false,
        checks: 'passing',
        review: 'none',
        createdAt: '2026-10-01T09:00:00.000Z',
        ticket: { id: reported, title: 'Add the berth map', status: 'open' },
        agent: { id: reporter, name: 'gannet' },
      },
      expect.objectContaining({
        number: 8,
        draft: true,
        author: null,
        checks: 'failing',
        review: 'changes',
        ticket: null,
        agent: null,
      }),
    ]);
    expect(sample?.requests).toEqual([
      expect.objectContaining({
        number: 3,
        base: 'develop',
        checks: 'pending',
        review: 'approved',
        ticket: { id: branched, title: 'Fix the tide table', status: 'open' },
        agent: expect.objectContaining({ name: 'finch' }),
      }),
    ]);
  });

  it('shows one project’s forge error without breaking the others', async () => {
    lists.set('example', new Error('gh pr list failed: HTTP 502'));
    lists.set('sample', [listed({ url: SAMPLE_MR, number: 3 })]);

    const [example, sample] = await read();

    expect(example).toMatchObject({
      project: 'example',
      forge: 'github',
      requests: [],
      error: 'gh pr list failed: HTTP 502',
    });
    expect(sample).toMatchObject({ project: 'sample', error: null });
    expect(sample?.requests).toHaveLength(1);
  });

  it('caches each project’s list until the interval passes or a gate event lands', async () => {
    let clock = Date.parse('2026-10-03T12:00:00.000Z');
    const openRequests = createOpenRequests({
      stores: t.api.stores,
      homeDir: t.homeDir,
      hosts: host,
      refreshMs: 60_000,
      now: () => clock,
    });
    lists.set('example', [listed({ url: EXAMPLE_PR, number: 7 })]);

    await openRequests.read();
    await openRequests.read();
    expect(calls).toHaveLength(2);

    clock += 59_999;
    lists.set('example', []);
    const cached = await openRequests.read();
    expect(calls).toHaveLength(2);
    expect(cached[0]?.requests).toHaveLength(1);

    const store = await t.store('example');
    await store.db.query(
      `insert into events (project_id, kind, payload) values ($1, 'ticket.merged', '{}')`,
      [store.projectId],
    );
    const afterGate = await openRequests.read();
    expect(calls.slice(2)).toEqual(['github:example-org/example']);
    expect(afterGate[0]?.requests).toEqual([]);

    clock += 60_000;
    await openRequests.read();
    expect(calls).toHaveLength(5);
  });

  it('reads a GitLab project through glab on recorded replies, linked to its ticket', async () => {
    const ticketId = await createTicket('sample', 'Sound the fog horn');
    await assign('sample', ticketId, 'heron', SAMPLE_MR);
    const glabCalls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      glabCalls.push(args);
      const endpoint = args.at(-1) ?? '';
      if (endpoint.includes('state=opened'))
        return gitlabOpenList([
          {
            iid: 3,
            web_url: SAMPLE_MR,
            title: 'Sound the fog horn',
            source_branch: `heron-${ticketId.slice(0, 8)}`,
          },
        ]);
      if (endpoint.endsWith('/approvals')) return gitlabApprovals([OKAPI]);
      return gitlabMergeRequest({
        pipeline: { status: 'failed' },
        mergeRequest: { iid: 3 },
      });
    };
    const hosts: Record<Forge, ForgeHost> = {
      github: host('github'),
      gitlab: glabCli(glab),
    };
    const openRequests = createOpenRequests({
      stores: t.api.stores,
      homeDir: t.homeDir,
      hosts: (forge) => hosts[forge],
    });

    const read = forgeRequestsResultSchema.parse({
      projects: await openRequests.read(),
    });

    expect(glabCalls[0]?.slice(0, 3)).toEqual([
      'api',
      '--hostname',
      'gitlab.com',
    ]);
    const sample = read.projects.find(({ project }) => project === 'sample');
    expect(sample).toMatchObject({ forge: 'gitlab', error: null });
    expect(sample?.requests).toEqual([
      {
        url: SAMPLE_MR,
        number: 3,
        title: 'Sound the fog horn',
        author: 'finch',
        branch: `heron-${ticketId.slice(0, 8)}`,
        base: 'main',
        draft: false,
        checks: 'failing',
        review: 'approved',
        createdAt: '2026-10-02T13:58:40.117Z',
        ticket: { id: ticketId, title: 'Sound the fog horn', status: 'open' },
        agent: expect.objectContaining({ name: 'heron' }),
      },
    ]);
  });

  it('links by the reported URL before the branch, ignoring case and a trailing slash', () => {
    const tickets = [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', prUrl: null },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002', prUrl: `${EXAMPLE_PR}/` },
    ];
    const request = {
      url: EXAMPLE_PR.toUpperCase(),
      branch: 'gannet-aaaaaaaa',
    };

    expect(linkTicket(request, tickets)?.id).toBe(tickets[1]?.id);
    expect(linkTicket({ ...request, url: 'elsewhere' }, tickets)?.id).toBe(
      tickets[0]?.id,
    );
    expect(
      linkTicket({ url: 'elsewhere', branch: 'aaaaaaaab' }, tickets),
    ).toBeUndefined();
  });
});
