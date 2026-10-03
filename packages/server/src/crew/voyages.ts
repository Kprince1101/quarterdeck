import { AGENT_RETIRED_EVENT, type Agent } from '../agents/index.js';
import type { DeskReply } from '../api/context.js';
import {
  continueBuilder,
  openDriverVoyage,
  type DriverVoyage,
  type ProjectBrief,
} from '../driver/index.js';
import { getErrorMessage } from '../lib/errors.js';
import { RESTART_REASON } from '../lifecycle/index.js';
import { startPauseGate, type PauseGate } from '../pause/index.js';
import type { PlannerAdapters } from '../planner/sessions.js';
import {
  ENDED_REASON,
  KILLED_REASON,
  SETTLED_REASON,
  cleanUpVoyage,
  endVoyage,
  endVoyageWithoutDriver,
  killVoyage,
  startAutoEnd,
  type AutoEnd,
  type VoyageCleanup,
} from '../voyage-end/index.js';
import {
  projectTurnsDir,
  type Store,
  type StoreEvent,
} from '../store/index.js';
import {
  noteForEvent,
  projectNote,
  readWaitingTickets,
  waitingTicketsNote,
} from './driver-notes.js';
import {
  AgentExitedError,
  crewFailureReporter,
  reportToEach,
  type CrewService,
} from './failures.js';
import type { MachineRules } from './rules.js';
import {
  birthSeated,
  coordinatorDir,
  retireSeats,
  seatIn,
  type SeatedAgent,
} from './seats.js';
import {
  NO_VOYAGE_PROJECTS,
  builderContext,
  projectBrief,
  resolveLeg,
  voyageCharter,
  voyageSites,
  type CrewProject,
  type VoyageLeg,
} from './voyage-legs.js';
import { startVoyageRun, type VoyageRun } from './voyage-run.js';
import {
  activeVoyageIds,
  nextVoyageNumber,
  openVoyageLeg,
  voyageEnded,
  voyageStillOpen,
} from './voyage-rows.js';

export const DRIVER_FAILED_REASON = 'driver_failed';
export const START_FAILED_REASON = 'start_failed';
export const PROJECT_CLOSED_REASON = 'project_closed';

export type { DeskReply };

export interface CrewVoyagesOptions {
  projects: () => readonly CrewProject[];
  openStores: () => readonly Store[];
  rules: MachineRules;
  adapters: PlannerAdapters;
  home: string;
  homeDir: string;
  ensureReviewer: () => void;
  log: (err: unknown) => void;
}

export interface CrewVoyages {
  start: (goal: string) => Promise<DeskReply>;
  end: (voyage: number) => Promise<DeskReply>;
  kill: (voyage: number) => Promise<DeskReply>;
  join: (project: CrewProject) => Promise<void>;
  leave: (project: string) => Promise<void>;
  deliver: (agent: Agent, text: string) => Promise<boolean>;
  noteEvent: (project: CrewProject, event: StoreEvent) => void;
  idle: () => Promise<void>;
  close: () => Promise<void>;
}

interface LiveVoyage {
  number: number;
  goal: string;
  legs: VoyageLeg[];
  launching: Promise<void>;
  ending: boolean;
  briefs: ProjectBrief[];
  pause?: PauseGate;
  driver?: SeatedAgent;
  voyage?: DriverVoyage;
  charter?: string;
  run?: VoyageRun;
  auto?: AutoEnd;
}

const refuse = (error: string): DeskReply => ({ ok: false, error });

const noSuchVoyage = (voyage: number): string =>
  `voyage ${voyage} is not running`;

const leadOf = (live: LiveVoyage): VoyageLeg => {
  const [lead] = live.legs;
  if (lead === undefined) throw new Error('the voyage has no projects');
  return lead;
};

const cleanupResult = (
  leg: VoyageLeg,
  cleanup: VoyageCleanup,
): Record<string, unknown> => ({
  project: leg.project,
  voyageId: cleanup.voyageId,
  retired: cleanup.retired,
  closedCards: cleanup.closedCards,
  discardCards: cleanup.discardCards,
  reopened: cleanup.reopened,
});

export const startCrewVoyages = (options: CrewVoyagesOptions): CrewVoyages => {
  const { home, log } = options;
  const tasks = new Set<Promise<void>>();
  let current: LiveVoyage | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let noting: Promise<void> = Promise.resolve();
  let closing = false;

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };

  const track = (task: Promise<void>): Promise<void> => {
    const tracked = task.catch(log).finally(() => tasks.delete(tracked));
    tasks.add(tracked);
    return tracked;
  };

  const isLive = (live: LiveVoyage): boolean =>
    current === live && !live.ending && !closing;

  const reportLegs = (live: LiveVoyage, service: CrewService) =>
    reportToEach(
      live.legs.map((leg) => ({
        store: leg.store,
        links: { voyageId: leg.voyageId },
      })),
      service,
      log,
    );

  const closeDriver = async (live: LiveVoyage): Promise<void> => {
    live.run?.close();
    await live.driver?.sessions.closeAll();
  };

  const stopLive = async (live: LiveVoyage): Promise<void> => {
    live.ending = true;
    live.auto?.close().catch(log);
    await closeDriver(live);
    await live.pause?.close();
  };

  const openLegs = async (live: LiveVoyage): Promise<VoyageLeg[]> => {
    const ended = await Promise.all(
      live.legs.map((leg) =>
        voyageEnded(leg.store, leg.voyageId).catch(() => false),
      ),
    );
    return live.legs.filter((_leg, index) => !ended[index]);
  };

  const stillOpenMessage = (
    live: LiveVoyage,
    open: readonly VoyageLeg[],
  ): string =>
    `voyage ${live.number} is still open in ${open.map((leg) => leg.project).join(', ')}; Kill all to end it`;

  const reportStillOpen = (
    live: LiveVoyage,
    open: readonly VoyageLeg[],
  ): void => {
    reportToEach(
      open.map((leg) => ({
        store: leg.store,
        links: { voyageId: leg.voyageId },
      })),
      'voyages',
      log,
    )(new Error(stillOpenMessage(live, open)));
  };

  const settleLive = async (live: LiveVoyage): Promise<VoyageLeg[]> => {
    const open = await openLegs(live);
    if (current !== live) return open;
    if (open.length === 0) current = undefined;
    else live.ending = false;
    return open;
  };

  const driverExited = (live: LiveVoyage) => (): void => {
    const driver = live.driver;
    if (driver === undefined || !isLive(live)) return;
    reportLegs(live, 'driver')(new AgentExitedError(driver.lead.agent));
  };

  const birthDriver = async (live: LiveVoyage, pause: PauseGate) => {
    const [models, naming, rules] = await Promise.all([
      options.rules.load('models'),
      options.rules.load('naming'),
      options.rules.load('lifecycle'),
    ]);
    return pause.hold(
      { operation: 'launch', label: `Driver, voyage ${live.number}` },
      () =>
        birthSeated({
          role: 'driver',
          runtime: models.driver.runtime,
          sites: live.legs,
          naming,
          budget: rules.budget.window,
          openStores: options.openStores,
          adapters: options.adapters,
          home,
          homeDir: options.homeDir,
          passEnv: async () => (await options.rules.load('env')).pass,
          onExit: driverExited(live),
        }),
    );
  };

  const openVoyage = async (
    live: LiveVoyage,
    driver: SeatedAgent,
    pause: PauseGate,
  ): Promise<DriverVoyage> => {
    const [charter, rules] = await Promise.all([
      options.rules.load('charter'),
      options.rules.load('lifecycle'),
    ]);
    const lead = leadOf(live);
    live.briefs = await Promise.all(live.legs.map(projectBrief));
    live.charter = voyageCharter(charter, live.briefs);
    return openDriverVoyage({
      store: lead.store,
      client: driver.sessions.driverClient(driver.lead.agent.id),
      bus: lead.bus,
      agentId: driver.lead.agent.id,
      voyageId: lead.voyageId,
      cwd: coordinatorDir(home),
      charter: live.charter,
      turnsDir: projectTurnsDir(lead.project, home),
      budget: rules.budget.window,
      pause,
      seats: driver.seats.map((seat) => ({
        project: seat.project,
        store: seat.store,
        bus: seat.bus,
        agentId: seat.agent.id,
        voyageId: seat.voyageId ?? '',
      })),
      projects: live.briefs,
    });
  };

  const noteLateTickets = async (
    live: LiveVoyage,
    voyageRun: VoyageRun,
  ): Promise<void> => {
    for (const leg of live.legs) {
      const brief = live.briefs.find((each) => each.project === leg.project);
      const briefed = new Set(brief?.waiting.map(({ id }) => id));
      const late = (await readWaitingTickets(leg.store)).filter(
        ({ id }) => !briefed.has(id),
      );
      if (late.length > 0)
        voyageRun.note(projectNote(leg.project, waitingTicketsNote(late)));
    }
  };

  const run = async (live: LiveVoyage, voyage: DriverVoyage): Promise<void> => {
    const rules = await options.rules.load('lifecycle');
    const lead = leadOf(live);
    live.auto = await startAutoEnd({
      legs: live.legs,
      settleSeconds: rules.autoEndSettleSeconds,
      home,
      onError: log,
      end: () => endLive(live, SETTLED_REASON),
    });
    live.run = startVoyageRun({
      voyage,
      charter: live.charter ?? '',
      resolve: (action) => resolveLeg(live.legs, action, home),
      report: crewFailureReporter(lead.store, log),
    });
    await noteLateTickets(live, live.run);
  };

  const closeLegs = async (
    legs: readonly VoyageLeg[],
    reason: string,
  ): Promise<void> => {
    for (const leg of legs) {
      await cleanUpVoyage({
        store: leg.store,
        lifecycle: leg.lifecycle,
        voyageId: leg.voyageId,
        reason,
        reopen: true,
      }).catch(log);
    }
  };

  const failLaunch = (live: LiveVoyage, err: unknown): Promise<void> =>
    serial(async () => {
      if (!isLive(live)) return;
      reportLegs(live, 'driver')(err);
      await stopLive(live);
      await closeLegs(live.legs, DRIVER_FAILED_REASON);
      await settleLive(live);
    });

  const dropDriver = async (live: LiveVoyage): Promise<void> => {
    await closeDriver(live);
    const seats = live.driver?.seats ?? [];
    await retireSeats(seats, AGENT_RETIRED_EVENT).catch(log);
  };

  const launchSteps = async (live: LiveVoyage): Promise<void> => {
    const pause = await startPauseGate({
      store: leadOf(live).store,
      home,
      global: true,
      onError: log,
    });
    live.pause = pause;
    if (!isLive(live)) return pause.close();
    live.driver = await birthDriver(live, pause);
    if (!isLive(live)) return dropDriver(live);
    live.voyage = await openVoyage(live, live.driver, pause);
    if (!isLive(live)) return dropDriver(live);
    await run(live, live.voyage);
    if (!isLive(live)) return dropDriver(live);
    return undefined;
  };

  const launch = async (live: LiveVoyage): Promise<void> => {
    try {
      await launchSteps(live);
    } catch (err) {
      if (!isLive(live)) {
        await dropDriver(live);
        return;
      }
      await failLaunch(live, err);
    }
  };

  const endLegs = async (live: LiveVoyage, reason: string) => {
    const { voyage, driver } = live;
    if (voyage === undefined || driver === undefined) {
      await closeDriver(live);
      const cleanups: Record<string, unknown>[] = [];
      for (const leg of live.legs) {
        const ended = await endVoyageWithoutDriver({
          store: leg.store,
          lifecycle: leg.lifecycle,
          voyageId: leg.voyageId,
        });
        cleanups.push(cleanupResult(leg, ended.cleanup));
      }
      return cleanups;
    }
    const lead = leadOf(live);
    const ended = await endVoyage({
      store: lead.store,
      lifecycle: lead.lifecycle,
      voyage,
      charter: live.charter ?? '',
      reason,
      legs: live.legs.map((leg) => ({
        project: leg.project,
        store: leg.store,
        voyageId: leg.voyageId,
        agentId: seatIn(driver, leg.store)?.agent.id ?? null,
        lifecycle: leg.lifecycle,
      })),
      closeDriver: () => closeDriver(live),
    });
    return ended.cleanups.map((cleanup, index) => {
      const leg = live.legs[index] ?? lead;
      return cleanupResult(leg, cleanup);
    });
  };

  const endLive = (live: LiveVoyage, reason: string): Promise<void> =>
    serial(async () => {
      if (!isLive(live)) return;
      live.ending = true;
      live.auto?.close().catch(log);
      live.run?.close();
      await endLegs(live, reason).catch(log);
      await stopLive(live);
      await closeLegs(await openLegs(live), reason);
      const open = await settleLive(live);
      if (open.length > 0) reportStillOpen(live, open);
    });

  const liveVoyage = (voyage: number): LiveVoyage | undefined => {
    const live = current;
    if (live === undefined || live.number !== voyage || live.ending)
      return undefined;
    return live;
  };

  const start = (goal: string): Promise<DeskReply> =>
    serial(async () => {
      if (closing) return refuse('the crew is stopping');
      if (current !== undefined) return refuse(voyageStillOpen(current.number));
      const sites = await voyageSites(options.projects());
      if (sites.length === 0) return refuse(NO_VOYAGE_PROJECTS);
      const number = await nextVoyageNumber(
        options.projects().map(({ store }) => store),
      );
      const projects = sites.map((site) => site.project);
      const legs: VoyageLeg[] = [];
      try {
        for (const site of sites) {
          const opened = await openVoyageLeg(site, { number, goal, projects });
          legs.push({ ...site.crew, ...opened, repoPath: site.repoPath });
        }
      } catch (err) {
        log(err);
        await closeLegs(legs, START_FAILED_REASON);
        return refuse(
          `voyage ${number} could not be opened: ${getErrorMessage(err)}`,
        );
      }
      const live: LiveVoyage = {
        number,
        goal,
        legs,
        ending: false,
        briefs: [],
        launching: Promise.resolve(),
      };
      current = live;
      live.launching = track(launch(live));
      options.ensureReviewer();
      return { ok: true, result: { voyage: number, goal, projects } };
    });

  const end = async (voyage: number): Promise<DeskReply> => {
    const live = liveVoyage(voyage);
    if (live === undefined) return refuse(noSuchVoyage(voyage));
    track(endLive(live, ENDED_REASON));
    return { ok: true, result: { voyage, ending: true } };
  };

  const kill = (voyage: number): Promise<DeskReply> =>
    serial(async () => {
      const live = liveVoyage(voyage);
      if (live === undefined) return refuse(noSuchVoyage(voyage));
      await stopLive(live);
      const projects: Record<string, unknown>[] = [];
      for (const leg of live.legs) {
        try {
          const cleanup = await killVoyage({
            store: leg.store,
            lifecycle: leg.lifecycle,
            voyageId: leg.voyageId,
          });
          projects.push(cleanupResult(leg, cleanup));
        } catch (err) {
          log(err);
        }
      }
      const open = await settleLive(live);
      if (open.length > 0) return refuse(stillOpenMessage(live, open));
      return {
        ok: true,
        result: { voyage, reason: KILLED_REASON, projects },
      };
    });

  const join = async (project: CrewProject): Promise<void> => {
    for (const voyageId of await activeVoyageIds(project.store)) {
      await cleanUpVoyage({
        store: project.store,
        lifecycle: project.lifecycle,
        voyageId,
        reason: RESTART_REASON,
        reopen: true,
      }).catch(log);
    }
  };

  const leave = async (project: string): Promise<void> => {
    const live = current;
    if (live?.legs.some((leg) => leg.project === project) !== true) return;
    live.legs = live.legs.filter((leg) => leg.project !== project);
    await stopLive(live);
    track(
      serial(async () => {
        await closeLegs(live.legs, PROJECT_CLOSED_REASON);
        await settleLive(live);
      }),
    );
  };

  const legOf = (live: LiveVoyage, agent: Agent): VoyageLeg | undefined =>
    live.legs.find(
      (leg) =>
        leg.store.projectId === agent.projectId &&
        leg.voyageId === agent.voyageId,
    );

  const deliver = async (agent: Agent, text: string): Promise<boolean> => {
    const live = current;
    if (live === undefined) return false;
    await live.launching;
    const leg = legOf(live, agent);
    const { run: voyageRun } = live;
    if (leg === undefined || voyageRun === undefined || !isLive(live))
      return false;
    if (agent.role === 'driver') {
      voyageRun.message(text);
      return true;
    }
    if (agent.role !== 'builder') return false;
    const builders = await builderContext(leg, home);
    const continuation = await continueBuilder(builders, {
      builderId: agent.id,
      prompt: text,
    });
    voyageRun.watchBuilder(
      { project: leg.project, builders },
      agent,
      continuation.ticketId,
      continuation.turn,
    );
    return true;
  };

  const noteEvent = (project: CrewProject, event: StoreEvent): void => {
    noting = noting
      .then(async () => {
        const live = current;
        if (live?.run === undefined || !isLive(live)) return;
        if (!live.legs.some((leg) => leg.project === project.project)) return;
        const note = await noteForEvent(project.store, event);
        if (note) live.run.note(projectNote(project.project, note));
      })
      .catch(log);
  };

  return {
    start,
    end,
    kill,
    join,
    leave,
    deliver,
    noteEvent,
    idle: async () => {
      while (tasks.size > 0) await Promise.allSettled(tasks);
      await noting;
    },
    close: async () => {
      closing = true;
      const live = current;
      current = undefined;
      if (live !== undefined) await stopLive(live);
      while (tasks.size > 0) await Promise.allSettled(tasks);
      await noting;
    },
  };
};
