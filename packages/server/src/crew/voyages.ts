import { gitWorktrees, type AgentLifecycle } from '../agents/index.js';
import type { BusHost } from '../bus/index.js';
import {
  openDriverVoyage,
  type BuilderContext,
  type DriverVoyage,
} from '../driver/index.js';
import { GATE_EVENTS } from '../gate/index.js';
import { RESTART_REASON } from '../lifecycle/index.js';
import type { PauseGuard } from '../pause/index.js';
import {
  VOYAGE_ENDED_EVENT,
  cleanUpVoyage,
  startVoyageAutoEnd,
  startVoyageControl,
  type AutoEnd,
  type VoyageControl,
} from '../voyage-end/index.js';
import {
  projectTurnsDir,
  projectWorktreesDir,
  type Store,
  type StoreEvent,
} from '../store/index.js';
import {
  DRIVER_NOTE_KINDS,
  noteForEvent,
  readWaitingTickets,
  waitingTicketsNote,
} from './driver-notes.js';
import type { CrewFailureReporter } from './failures.js';
import { startCrewIntents, type CrewIntents } from './intents.js';
import type { ReviewerDesk } from './reviewer.js';
import { startVoyageRun, type VoyageRun } from './voyage-run.js';
import {
  activeVoyageIds,
  voyageEnded,
  voyageIdOf,
  type OpenedVoyage,
} from './voyage-rows.js';
import { baseRef, type CrewRules } from './rules.js';
import type { CrewSessionHost } from './sessions.js';

export const DRIVER_FAILED_REASON = 'driver_failed';

export interface CrewVoyagesOptions {
  store: Store;
  project: string;
  home: string;
  sessions: CrewSessionHost;
  lifecycle: AgentLifecycle;
  pause: PauseGuard;
  bus: Pick<BusHost, 'launch'>;
  rules: CrewRules;
  reviewers: Pick<ReviewerDesk, 'ensure'>;
  report: CrewFailureReporter;
}

export interface CrewVoyages {
  live: (voyageId: string) => VoyageRun | undefined;
  runs: () => VoyageRun[];
  drain: () => Promise<void>;
  close: () => Promise<void>;
  idle: () => Promise<void>;
}

interface LiveVoyage {
  run: VoyageRun;
  auto: AutoEnd;
}

export const startCrewVoyages = async (
  options: CrewVoyagesOptions,
): Promise<CrewVoyages> => {
  const { store, lifecycle, report } = options;
  const live = new Map<string, LiveVoyage>();
  const launching = new Map<string, Promise<void>>();
  const tasks = new Set<Promise<void>>();
  const turnsDir = projectTurnsDir(options.project, options.home);
  let noting: Promise<void> = Promise.resolve();
  let closing = false;

  const track = (task: Promise<void>): void => {
    const tracked = task
      .catch(report('voyages'))
      .finally(() => tasks.delete(tracked));
    tasks.add(tracked);
  };

  const finish = (voyageId: string): void => {
    const entry = live.get(voyageId);
    if (!entry) return;
    live.delete(voyageId);
    entry.run.close();
    entry.auto.close().catch(report('voyages', { voyageId }));
  };

  const birthDriver = async (voyage: OpenedVoyage): Promise<DriverVoyage> => {
    const [models, charter, rules, repoPath] = await Promise.all([
      options.rules.load('models'),
      options.rules.load('charter'),
      options.rules.load('lifecycle'),
      options.rules.repoPath(),
    ]);
    const driver = await options.pause.hold(
      { operation: 'launch', label: `Driver, voyage ${voyage.number}` },
      () =>
        lifecycle.birth({
          store,
          role: 'driver',
          runtime: models.driver.runtime,
          voyageId: voyage.id,
        }),
    );
    return openDriverVoyage({
      store,
      client: options.sessions.driverClient(driver.id),
      bus: options.bus,
      agentId: driver.id,
      voyageId: voyage.id,
      cwd: repoPath,
      charter,
      turnsDir,
      budget: rules.budget.window,
      pause: options.pause,
    });
  };

  const builderContext = async (
    voyage: DriverVoyage,
  ): Promise<BuilderContext> => {
    const [models, rules, repoPath] = await Promise.all([
      options.rules.load('models'),
      options.rules.load('lifecycle'),
      options.rules.repoPath(),
    ]);
    return {
      store,
      lifecycle,
      sessions: options.sessions,
      worktrees: gitWorktrees,
      runtime: models.builder.runtime,
      repoPath,
      base: await baseRef(repoPath, rules.mergeGate.base),
      worktreesDir: projectWorktreesDir(options.project, options.home),
      turnsDir,
      budget: rules.budget.window,
      pause: options.pause,
      voyageId: voyage.voyage.id,
    };
  };

  const run = async (voyage: DriverVoyage): Promise<void> => {
    const [charter, rules] = await Promise.all([
      options.rules.load('charter'),
      options.rules.load('lifecycle'),
    ]);
    const voyageId = voyage.voyage.id;
    const builders = await builderContext(voyage);
    const auto = await startVoyageAutoEnd({
      store,
      voyage,
      charter,
      lifecycle,
      settleSeconds: rules.autoEndSettleSeconds,
      home: options.home,
      onError: report('voyages', { voyageId }),
    });
    const started = startVoyageRun({
      store,
      voyage,
      charter,
      builders,
      report,
    });
    live.set(voyageId, { run: started, auto });
    const waiting = await readWaitingTickets(store);
    if (waiting.length > 0) started.note(waitingTicketsNote(waiting));
    if (closing || (await voyageEnded(store, voyageId))) finish(voyageId);
  };

  const launch = async (voyage: OpenedVoyage): Promise<void> => {
    const links = { voyageId: voyage.id };
    options.reviewers.ensure().catch(report('reviewer', links));
    try {
      await run(await birthDriver(voyage));
    } catch (err) {
      if (closing) return;
      report('driver', links)(err);
      await cleanUpVoyage({
        store,
        lifecycle,
        voyageId: voyage.id,
        reason: DRIVER_FAILED_REASON,
        reopen: true,
      }).catch(report('voyages', links));
    }
  };

  const endStaleVoyages = async (): Promise<void> => {
    for (const voyageId of await activeVoyageIds(store)) {
      await cleanUpVoyage({
        store,
        lifecycle,
        voyageId,
        reason: RESTART_REASON,
        reopen: true,
      }).catch(report('voyages', { voyageId }));
    }
  };

  const runs = (): VoyageRun[] => [...live.values()].map((entry) => entry.run);

  const noteEvent = (event: StoreEvent): void => {
    noting = noting
      .then(async () => {
        const active = runs();
        if (active.length === 0) return;
        const note = await noteForEvent(store, event);
        if (note) for (const target of active) target.note(note);
      })
      .catch(report('voyages'));
  };

  const onEvent = (event: StoreEvent): void => {
    if (event.kind === VOYAGE_ENDED_EVENT) {
      const voyageId = voyageIdOf(event);
      if (voyageId !== undefined) finish(voyageId);
      return;
    }
    if (event.kind === GATE_EVENTS.reported)
      options.reviewers.ensure().catch(report('reviewer'));
    if (DRIVER_NOTE_KINDS.includes(event.kind)) noteEvent(event);
  };

  await endStaleVoyages();
  const subscription = await store.subscribe(onEvent, {
    onError: report('voyages'),
  });
  const control: VoyageControl = await startVoyageControl({
    store,
    lifecycle,
    driver: (voyageId) => live.get(voyageId)?.run.driver,
    onError: report('voyages'),
  });
  const intents: CrewIntents = await startCrewIntents({
    store,
    runs,
    report,
    start: (voyage) => {
      const launched = launch(voyage).finally(() =>
        launching.delete(voyage.id),
      );
      launching.set(voyage.id, launched);
      track(launched);
    },
    launched: async (voyageId) => {
      await launching.get(voyageId);
    },
    track,
  });

  return {
    live: (voyageId) => live.get(voyageId)?.run,
    runs,
    drain: async () => {
      await intents.drain();
      await control.drain();
    },
    close: async () => {
      closing = true;
      await subscription.close();
      track(intents.close());
      track(control.close());
      for (const voyageId of live.keys()) finish(voyageId);
    },
    idle: async () => {
      while (tasks.size > 0) await Promise.allSettled(tasks);
      await noting;
    },
  };
};
