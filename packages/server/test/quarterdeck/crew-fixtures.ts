import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineRuntimeAdapter,
  launchSite,
  parseMergeRequestUrl,
  parsePullRequestUrl,
  type AcpClient,
  type AcpClientOptions,
  type ForgeHost,
  type PlannerAdapters,
  type PullRequest,
  type RuntimeLaunch,
} from '../../src/index.js';
import type { Quarterdeck } from '../../src/quarterdeck/index.js';
import type { Store } from '../../src/store/index.js';
import {
  FAKE_PR_HEAD,
  fakeAgentLaunch,
  type FakeAgentOptions,
} from '../acp/fake-agent/index.ts';
import { bearer } from '../api/harness.ts';
import { git } from '../driver/builder-fixtures.ts';

export const TIMEOUT = 120_000;
export const WAIT = { timeout: 60_000, interval: 100 };

export interface CrewRuntime {
  adapters: PlannerAdapters;
  launches: RuntimeLaunch[];
}

export const crewRuntime = (
  projects: Record<string, FakeAgentOptions>,
): CrewRuntime => {
  const launches: RuntimeLaunch[] = [];
  const adapter = defineRuntimeAdapter({
    runtime: 'kiro',
    displayName: 'Fake crew',
    command: (launch) => ({
      ...launchSite(launch),
      ...fakeAgentLaunch({ crew: true, ...projects[launch.project ?? ''] }),
    }),
  });
  const connect = (
    launch: RuntimeLaunch,
    options: AcpClientOptions,
  ): Promise<AcpClient> => {
    launches.push(launch);
    return adapter.connect(launch, options);
  };
  return {
    adapters: { kiro: { connect }, claude: { connect }, gemini: { connect } },
    launches,
  };
};

export interface FakeGitHub extends ForgeHost {
  merges: { url: string; head: string }[];
}

const FAKE_FORGES = {
  github: { hostname: 'github.com', parse: parsePullRequestUrl },
  gitlab: { hostname: 'gitlab.com', parse: parseMergeRequestUrl },
} as const;

export const fakeGitLab = (): FakeGitHub => fakeGitHub('gitlab');

export const fakeGitHub = (
  forge: keyof typeof FAKE_FORGES = 'github',
): FakeGitHub => {
  const { hostname, parse } = FAKE_FORGES[forge];
  const merges: { url: string; head: string }[] = [];
  const stateOf = (url: string): PullRequest['state'] => {
    if (merges.some((merge) => merge.url === url)) return 'merged';
    return 'open';
  };
  const pullRequest = async (url: string): Promise<PullRequest> => ({
    repository: { hostname, owner: 'example', name: 'example' },
    base: 'main',
    defaultBranch: 'main',
    state: stateOf(url),
    head: FAKE_PR_HEAD,
    draft: false,
    mergeable: 'mergeable',
    checks: { state: 'passing', failing: [] },
    botReview: { reviewers: [], openThreads: [] },
  });
  return {
    forge,
    pullRequestRef: parse,
    merges,
    pullRequest,
    listOpen: async () => [],
    squashMerge: async (url, head) => {
      merges.push({ url, head });
    },
  };
};

export const writeMachineRule = async (
  homeDir: string,
  file: string,
  content: unknown,
): Promise<void> => {
  const dir = join(homeDir, '.quarterdeck');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rules.local.${file}`), JSON.stringify(content));
};

export const createRepo = async (): Promise<string> => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'qd-repo-')));
  git(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(repo, 'README.md'), '# example\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '--quiet', '-m', 'first');
  git(
    repo,
    'remote',
    'add',
    'origin',
    'https://github.com/example/example.git',
  );
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
};

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export const sendIntent = async (
  qd: Pick<Quarterdeck, 'url' | 'token'>,
  name: string,
  body: unknown,
): Promise<Reply> => {
  const res = await fetch(`${qd.url}/api/intents/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(qd.token) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Reply['body'] };
};

export const storeOf = (qd: Quarterdeck, project: string): Store => {
  const services = qd.projects.get(project);
  if (!services) throw new Error(`${project} has no services`);
  return services.store;
};

export interface EventRow {
  kind: string;
  agentId: string | null;
  ticketId: string | null;
  payload: Record<string, unknown>;
}

export const eventsOf = async (
  store: Store,
  kind: string,
): Promise<EventRow[]> => {
  const { rows } = await store.db.query<EventRow>(
    `select kind, agent_id as "agentId", ticket_id as "ticketId", payload
     from events where project_id = $1 and kind = $2 order by id`,
    [store.projectId, kind],
  );
  return rows;
};

export const proposeTicket = async (
  store: Store,
  title: string,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into tickets (project_id, title, body, status)
     values ($1, $2, 'Say hello in the README.', 'proposed') returning id`,
    [store.projectId, title],
  );
  const [row] = rows;
  if (!row) throw new Error('the ticket was not proposed');
  return row.id;
};

export const valueOf = async <T>(
  store: Store,
  sql: string,
  params: unknown[],
): Promise<T | undefined> => {
  const { rows } = await store.db.query<{ value: T }>(sql, params);
  return rows[0]?.value;
};
