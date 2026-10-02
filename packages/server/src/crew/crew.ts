import type { Agent, AgentLifecycle, AgentRole } from '../agents/index.js';
import { startArchiveControl } from '../archive/index.js';
import type { BusHost } from '../bus/index.js';
import {
  ghCli,
  startReviewGate,
  type GitHubHost,
  type ReviewGate,
  type ReviewGateOptions,
} from '../gate/index.js';
import { startLifecycleIntents } from '../lifecycle/index.js';
import { startPauseGate, type PauseGate } from '../pause/index.js';
import { startPlanner, type Planner } from '../planner/index.js';
import { PLANNER_ADAPTERS, type PlannerAdapters } from '../planner/sessions.js';
import { projectTurnsDir, type Store } from '../store/index.js';
import {
  crewFailureReporter,
  type CrewFailureReporter,
  type CrewService,
} from './failures.js';
import { crewLifecycle } from './lifecycle.js';
import { createReviewerDesk, type ReviewerDesk } from './reviewer.js';
import { startCrewRounds, type CrewRounds } from './rounds.js';
import { crewRules, type CrewRules } from './rules.js';
import { createCrewSessions, type CrewSessionHost } from './sessions.js';

export interface CrewOptions {
  store: Store;
  project: string;
  home: string;
  homeDir: string;
  bus: BusHost;
  openStores: () => readonly Store[];
  adapters?: PlannerAdapters | undefined;
  github?: GitHubHost | undefined;
  gatePollMs?: number | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

export interface Crew {
  pause: PauseGate;
  sessions: CrewSessionHost;
  lifecycle: AgentLifecycle;
  reviewers: ReviewerDesk;
  planner: Planner | undefined;
  gate: ReviewGate | undefined;
  rounds: CrewRounds | undefined;
  close: () => Promise<void>;
}

interface Closable {
  close: () => Promise<void>;
}

const SERVICE_OF_ROLE: Record<AgentRole, CrewService> = {
  planner: 'planner',
  driver: 'driver',
  builder: 'builder',
  reviewer: 'reviewer',
};

const reportError = (err: unknown): void => {
  console.error(err);
};

export class AgentExitedError extends Error {
  constructor(agent: Pick<Agent, 'name'>) {
    super(`${agent.name}'s process exited`);
    this.name = 'AgentExitedError';
  }
}

const exitLinks = (agent: Agent) => {
  if (agent.roundId === null) return { agentId: agent.id };
  return { agentId: agent.id, roundId: agent.roundId };
};

const retireStaleReviewers = async (
  store: Store,
  lifecycle: AgentLifecycle,
): Promise<void> => {
  const { rows } = await store.db.query<{ id: string }>(
    `select id from agents
     where project_id = $1 and role = 'reviewer' and status <> 'retired'
     order by created_at`,
    [store.projectId],
  );
  for (const { id } of rows) await lifecycle.retire(store, id);
};

const attempt = async <T extends Closable>(
  report: CrewFailureReporter,
  service: CrewService,
  start: () => Promise<T>,
): Promise<T | undefined> => {
  try {
    return await start();
  } catch (err) {
    report(service)(err);
    return undefined;
  }
};

interface CrewParts {
  options: CrewOptions;
  report: CrewFailureReporter;
  rules: CrewRules;
  pause: PauseGate;
  sessions: CrewSessionHost;
  lifecycle: AgentLifecycle;
  reviewers: ReviewerDesk;
}

const startServices = async (parts: CrewParts) => {
  const { options, report, rules, pause, sessions, lifecycle, reviewers } =
    parts;
  const { store } = options;
  await retireStaleReviewers(store, lifecycle).catch(report('reviewer'));
  const planner = await attempt(report, 'planner', () =>
    startPlanner({
      store,
      bus: options.bus,
      pause,
      openStores: options.openStores,
      adapters: options.adapters ?? PLANNER_ADAPTERS,
      homeDir: options.homeDir,
      onError: report('planner'),
    }),
  );
  const intents = await attempt(report, 'intents', () =>
    startLifecycleIntents({ store, lifecycle, onError: report('intents') }),
  );
  const archive = await attempt(report, 'archive', () =>
    startArchiveControl({ store, lifecycle, onError: report('archive') }),
  );
  const gate = await attempt(report, 'gate', async () => {
    const gateOptions: ReviewGateOptions = {
      store,
      rules: (await rules.load('lifecycle')).mergeGate,
      github: options.github ?? ghCli(),
      reviewers,
      onError: report('gate'),
    };
    if (options.gatePollMs !== undefined)
      gateOptions.pollMs = options.gatePollMs;
    return startReviewGate(gateOptions);
  });
  const rounds = await attempt(report, 'rounds', () =>
    startCrewRounds({
      store,
      project: options.project,
      home: options.home,
      sessions,
      lifecycle,
      pause,
      bus: options.bus,
      rules,
      reviewers,
      report,
    }),
  );
  return { planner, intents, archive, gate, rounds };
};

export const startCrew = async (options: CrewOptions): Promise<Crew> => {
  const { store } = options;
  const report = crewFailureReporter(store, options.onError ?? reportError);
  const rules = crewRules(store, options.homeDir);
  const pause = await startPauseGate({
    store,
    home: options.home,
    onError: report('start'),
  });
  const sessions = createCrewSessions({
    store,
    slug: options.project,
    bus: options.bus,
    adapters: options.adapters ?? PLANNER_ADAPTERS,
    repoPath: rules.repoPath,
    passEnv: async () => (await rules.load('env')).pass,
    onExit: (agent) => {
      exited(agent);
    },
  });
  const lifecycle = crewLifecycle({
    rules,
    sessions,
    openStores: options.openStores,
  });
  const exited = (agent: Agent): void => {
    const links = exitLinks(agent);
    report(SERVICE_OF_ROLE[agent.role], links)(new AgentExitedError(agent));
    if (agent.role === 'reviewer')
      lifecycle.retire(store, agent.id).catch(report('reviewer', links));
  };
  const reviewers = createReviewerDesk({
    store,
    sessions,
    lifecycle,
    turnsDir: projectTurnsDir(options.project, options.home),
    brief: () => rules.load('reviewer'),
    runtime: async () => (await rules.load('models')).reviewer.runtime,
    report,
  });
  const services = await startServices({
    options,
    report,
    rules,
    pause,
    sessions,
    lifecycle,
    reviewers,
  });

  const close = async (): Promise<void> => {
    const { rounds } = services;
    await rounds?.close();
    const listeners: (Closable | undefined)[] = [
      services.gate,
      services.archive,
      services.intents,
      services.planner,
    ];
    for (const listener of listeners)
      await listener?.close().catch(report('start'));
    await sessions.closeAll();
    await reviewers.close();
    await pause.close();
    await rounds?.idle();
  };
  let closing: Promise<void> | undefined;

  return {
    pause,
    sessions,
    lifecycle,
    reviewers,
    planner: services.planner,
    gate: services.gate,
    rounds: services.rounds,
    close: () => {
      closing ??= close();
      return closing;
    },
  };
};
