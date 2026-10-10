import { GATE_EVENTS, type ReviewerHost } from '../gate/index.js';
import { isProjectArchived } from '../pause/index.js';
import { PLANNER_ADAPTERS, type PlannerAdapters } from '../planner/sessions.js';
import {
  projectTurnsDir,
  type Store,
  type StoreEvent,
  type Subscription,
} from '../store/index.js';
import { DRIVER_NOTE_KINDS, WAKE_EVENT_KINDS } from './driver-notes.js';
import { reportToEach } from './failures.js';
import { startCrewIntents, type CrewIntents } from './intents.js';
import { createReviewerDesk } from './reviewer.js';
import { machineRules, reviewerBrief, type ModeSource } from './rules.js';
import { birthSeated, type SeatSite } from './seats.js';
import { ticketServices, type CrewProject } from './voyage-legs.js';
import { startCrewVoyages, type CrewVoyages } from './voyages.js';

export interface CoordinatorOptions {
  home: string;
  homeDir: string;
  openStores: () => readonly Store[];
  adapters?: PlannerAdapters | undefined;
  mode?: ModeSource | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

export type VoyageDesk = Pick<CrewVoyages, 'start' | 'end' | 'kill'>;

export interface Coordinator {
  desk: VoyageDesk;
  reviewers: ReviewerHost;
  join: (project: CrewProject) => Promise<void>;
  leave: (project: string) => Promise<void>;
  idle: () => Promise<void>;
  close: () => Promise<void>;
}

interface Joined {
  crew: CrewProject;
  subscription: Subscription;
  intents: CrewIntents;
}

const reportError = (err: unknown): void => {
  console.error(err);
};

export const startCoordinator = (options: CoordinatorOptions): Coordinator => {
  const log = options.onError ?? reportError;
  const adapters = options.adapters ?? PLANNER_ADAPTERS;
  const rules = machineRules(options.homeDir, options.mode);
  const joined = new Map<string, Joined>();
  const tasks = new Set<Promise<void>>();
  let closed = false;

  const track = (task: Promise<void>): void => {
    const tracked = task.catch(log).finally(() => tasks.delete(tracked));
    tasks.add(tracked);
  };

  const projects = (): CrewProject[] =>
    [...joined.values()]
      .map(({ crew }) => crew)
      .toSorted((a, b) => a.project.localeCompare(b.project));

  const reviewerSites = async (): Promise<SeatSite[]> => {
    const sites: SeatSite[] = [];
    for (const crew of projects()) {
      const { store } = crew;
      if (!(await isProjectArchived(store.db, store.projectId)))
        sites.push({ project: crew.project, store, bus: crew.bus });
    }
    return sites;
  };

  const reviewers = createReviewerDesk({
    sites: reviewerSites,
    turnsDir: (project) => projectTurnsDir(project, options.home),
    brief: (project) => reviewerBrief(joined.get(project)?.crew.rules ?? rules),
    services: async (project, ticketId) => {
      const crew = joined.get(project)?.crew;
      if (crew === undefined)
        throw new Error(`project ${project} is not in the crew`);
      return ticketServices(crew, ticketId);
    },
    report: (targets) => reportToEach(targets, 'reviewer', log),
    mode: rules.mode,
    birth: async (sites) => {
      const [models, naming, lifecycle] = await Promise.all([
        rules.load('models'),
        rules.load('naming'),
        rules.load('lifecycle'),
      ]);
      return birthSeated({
        role: 'reviewer',
        runtime: models.reviewer.runtime,
        sites,
        naming,
        budget: lifecycle.budget.window,
        openStores: options.openStores,
        adapters,
        home: options.home,
        homeDir: options.homeDir,
        passEnv: async () => (await rules.load('env')).pass,
        onExit: () => reviewers.exited(),
      });
    },
  });

  const ensureReviewer = (): void => {
    if (!closed) track(reviewers.ensure());
  };

  const voyages = startCrewVoyages({
    projects,
    openStores: options.openStores,
    rules,
    adapters,
    home: options.home,
    homeDir: options.homeDir,
    ensureReviewer,
    log,
  });

  const onEvent =
    (crew: CrewProject) =>
    (event: StoreEvent): void => {
      if (event.kind === GATE_EVENTS.reported) ensureReviewer();
      if (
        DRIVER_NOTE_KINDS.includes(event.kind) ||
        WAKE_EVENT_KINDS.includes(event.kind)
      )
        voyages.noteEvent(crew, event);
    };

  const join = async (crew: CrewProject): Promise<void> => {
    if (closed) return;
    await voyages.join(crew);
    const subscription = await crew.store.subscribe(onEvent(crew), {
      onError: log,
    });
    const intents = await startCrewIntents({
      store: crew.store,
      deliver: voyages.deliver,
      report: log,
      track,
    });
    joined.set(crew.project, { crew, subscription, intents });
  };

  const leave = async (project: string): Promise<void> => {
    const entry = joined.get(project);
    if (entry === undefined) return;
    joined.delete(project);
    await voyages.leave(project);
    await entry.subscription.close();
    await entry.intents.close();
  };

  return {
    desk: { start: voyages.start, end: voyages.end, kill: voyages.kill },
    reviewers,
    join,
    leave,
    idle: async () => {
      await voyages.idle();
      while (tasks.size > 0) await Promise.allSettled(tasks);
    },
    close: async () => {
      closed = true;
      await voyages.close();
      for (const project of joined.keys()) await leave(project);
      await reviewers.close();
      while (tasks.size > 0) await Promise.allSettled(tasks);
    },
  };
};
