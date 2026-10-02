import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineRuntimeAdapter,
  launchSite,
  type AcpClient,
  type AcpClientOptions,
  type RuntimeLaunch,
} from '../../src/index.js';
import { startBusHost, type BusHost } from '../../src/bus/index.js';
import {
  startPlanner,
  type Planner,
  type PlannerAdapters,
} from '../../src/planner/index.js';
import type { Store } from '../../src/store/index.js';
import {
  fakeAgentLaunch,
  type FakeAgentOptions,
} from '../acp/fake-agent/index.ts';
import type { Reply, TestApi } from '../api/harness.ts';

export const TIMEOUT = 60_000;

export interface FakeRuntime {
  adapters: PlannerAdapters;
  launches: RuntimeLaunch[];
  clients: AcpClient[];
  options: FakeAgentOptions;
}

export const fakeRuntime = (initial: FakeAgentOptions = {}): FakeRuntime => {
  const options = { ...initial };
  const launches: RuntimeLaunch[] = [];
  const clients: AcpClient[] = [];
  const adapter = defineRuntimeAdapter({
    runtime: 'kiro',
    displayName: 'Fake',
    command: (launch) => ({
      ...launchSite(launch),
      ...fakeAgentLaunch(options),
    }),
  });
  const connect = async (
    launch: RuntimeLaunch,
    clientOptions: AcpClientOptions,
  ): Promise<AcpClient> => {
    launches.push(launch);
    const client = await adapter.connect(launch, clientOptions);
    clients.push(client);
    return client;
  };
  return {
    adapters: { kiro: { connect }, claude: { connect }, gemini: { connect } },
    launches,
    clients,
    options,
  };
};

export interface PlannerEvent {
  kind: string;
  agentId: string | null;
  payload: Record<string, unknown>;
}

export interface PlannerAgent {
  id: string;
  name: string;
  runtime: string;
  status: string;
  sessionId: string | null;
}

export interface PlannerProject {
  project: string;
  store: Store;
  repoDir: string;
  bus: BusHost;
  fake: FakeRuntime;
  errors: unknown[];
  send: (name: string, body?: Record<string, unknown>) => Promise<Reply>;
  start: () => Promise<Planner>;
  planner: () => Planner;
  events: () => Promise<PlannerEvent[]>;
  agents: () => Promise<PlannerAgent[]>;
  intent: (id: unknown) => Promise<{ status: string; result: unknown }>;
  close: () => Promise<void>;
}

export interface PlannerProjectOptions {
  repo?: boolean;
  fake?: FakeAgentOptions;
}

let projects = 0;

export const writeMachineRule = async (
  homeDir: string,
  file: string,
  content: unknown,
): Promise<void> => {
  const dir = join(homeDir, '.quarterdeck');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rules.local.${file}`), JSON.stringify(content));
};

export const openPlannerProject = async (
  t: TestApi,
  options: PlannerProjectOptions = {},
): Promise<PlannerProject> => {
  projects += 1;
  const project = `plan${projects}`;
  const repoDir = await realpath(await mkdtemp(join(tmpdir(), 'qd-plan-')));
  const created: Record<string, unknown> = { project };
  if (options.repo !== false) created['repoPath'] = repoDir;
  await t.send('project.create', created);
  const store = await t.store(project);
  const bus = await startBusHost({ store, home: t.homeDir });
  const fake = fakeRuntime(options.fake);
  const errors: unknown[] = [];
  let running: Planner | undefined;

  const start = async (): Promise<Planner> => {
    running = await startPlanner({
      store,
      bus,
      openStores: () => [store],
      adapters: fake.adapters,
      homeDir: t.homeDir,
      onError: (err) => errors.push(err),
    });
    return running;
  };

  const planner = (): Planner => {
    if (!running) throw new Error('the Planner has not started');
    return running;
  };

  const events = async (): Promise<PlannerEvent[]> => {
    const { rows } = await store.db.query<PlannerEvent>(
      `select kind, agent_id as "agentId", payload from events
       where project_id = $1
         and (kind like 'planner.%' or kind = 'ticket.proposed')
         and not (payload ? 'status')
       order by id`,
      [store.projectId],
    );
    return rows;
  };

  const agents = async (): Promise<PlannerAgent[]> => {
    const { rows } = await store.db.query<PlannerAgent>(
      `select id, name, runtime, status, session_id as "sessionId"
       from agents where project_id = $1 and role = 'planner'
       order by created_at`,
      [store.projectId],
    );
    return rows;
  };

  const intent = async (id: unknown) => {
    const { rows } = await store.db.query<{ status: string; result: unknown }>(
      'select status, result from intents where id = $1',
      [id],
    );
    const [row] = rows;
    if (!row) throw new Error(`intent ${String(id)} not found`);
    return row;
  };

  return {
    project,
    store,
    repoDir,
    bus,
    fake,
    errors,
    send: (name, body = {}) => t.send(name, { project, ...body }),
    start,
    planner,
    events,
    agents,
    intent,
    close: async () => {
      await running?.close();
      await bus.close();
      await rm(repoDir, { recursive: true, force: true });
    },
  };
};
