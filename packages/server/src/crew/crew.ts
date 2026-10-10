import type { Forge } from '@quarterdeck/rules';
import type { Agent, AgentLifecycle, AgentRole } from '../agents/index.js';
import { startArchiveControl } from '../archive/index.js';
import type { BusHost } from '../bus/index.js';
import {
  forgeHost,
  mergeForge,
  startReviewGate,
  type ForgeHost,
  type ReviewGate,
  type ReviewGateOptions,
} from '../gate/index.js';
import { startLifecycleIntents } from '../lifecycle/index.js';
import { startPauseGate, type PauseGate } from '../pause/index.js';
import { startPlanner, type Planner } from '../planner/index.js';
import { PLANNER_ADAPTERS, type PlannerAdapters } from '../planner/sessions.js';
import type { Store } from '../store/index.js';
import type { Coordinator } from './coordinator.js';
import {
  AgentExitedError,
  crewFailureReporter,
  type CrewFailureReporter,
  type CrewService,
} from './failures.js';
import { crewLifecycle } from './lifecycle.js';
import { cardPermissions } from './permission-card.js';
import { crewRules, type CrewRules, type ModeSource } from './rules.js';
import { createCrewSessions, type CrewSessionHost } from './sessions.js';
import type { CrewProject } from './voyage-legs.js';

export { AgentExitedError };

export interface CrewOptions {
  store: Store;
  project: string;
  home: string;
  homeDir: string;
  bus: BusHost;
  coordinator: Pick<Coordinator, 'join' | 'leave' | 'reviewers'>;
  openStores: () => readonly Store[];
  adapters?: PlannerAdapters | undefined;
  forge?: ForgeHost | undefined;
  gatePollMs?: number | undefined;
  mode?: ModeSource | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

export interface Crew {
  pause: PauseGate;
  sessions: CrewSessionHost;
  lifecycle: AgentLifecycle;
  planner: Planner | undefined;
  gate: ReviewGate | undefined;
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

const injectedForge = (
  host: ForgeHost | undefined,
): (() => Promise<Forge>) | undefined => {
  if (host === undefined) return undefined;
  return () => Promise.resolve(host.forge);
};

const exitLinks = (agent: Agent) => {
  if (agent.voyageId === null) return { agentId: agent.id };
  return { agentId: agent.id, voyageId: agent.voyageId };
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
  lifecycle: AgentLifecycle;
}

const startServices = async (parts: CrewParts) => {
  const { options, report, rules, pause, lifecycle } = parts;
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
      mode: rules.mode,
      permissionCards: (agent, signal) =>
        cardPermissions({ store, agent, signal }),
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
      forge:
        options.forge ??
        (async () =>
          forgeHost(await mergeForge(store, { homeDir: options.homeDir }))),
      reviewers: options.coordinator.reviewers,
      onError: report('gate'),
    };
    if (options.gatePollMs !== undefined)
      gateOptions.pollMs = options.gatePollMs;
    return startReviewGate(gateOptions);
  });
  return { planner, intents, archive, gate };
};

export const startCrew = async (options: CrewOptions): Promise<Crew> => {
  const { store } = options;
  const report = crewFailureReporter(store, options.onError ?? reportError);
  const rules = crewRules(
    store,
    options.homeDir,
    injectedForge(options.forge),
    options.mode,
  );
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
    homeDir: options.homeDir,
    passEnv: async () => (await rules.load('env')).pass,
    onExit: (agent) => {
      report(
        SERVICE_OF_ROLE[agent.role],
        exitLinks(agent),
      )(new AgentExitedError(agent));
    },
  });
  const lifecycle = crewLifecycle({
    rules,
    sessions,
    openStores: options.openStores,
  });
  const services = await startServices({
    options,
    report,
    rules,
    pause,
    lifecycle,
  });
  const project: CrewProject = {
    project: options.project,
    store,
    bus: options.bus,
    pause,
    sessions,
    lifecycle,
    rules,
  };
  await options.coordinator.join(project).catch(report('voyages'));

  const close = async (): Promise<void> => {
    await options.coordinator.leave(options.project).catch(report('start'));
    const listeners: (Closable | undefined)[] = [
      services.gate,
      services.archive,
      services.intents,
      services.planner,
    ];
    for (const listener of listeners)
      await listener?.close().catch(report('start'));
    await sessions.closeAll();
    await pause.close();
  };
  let closing: Promise<void> | undefined;

  return {
    pause,
    sessions,
    lifecycle,
    planner: services.planner,
    gate: services.gate,
    close: () => {
      closing ??= close();
      return closing;
    },
  };
};
