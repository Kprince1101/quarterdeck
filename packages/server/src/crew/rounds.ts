import { gitWorktrees, type AgentLifecycle } from '../agents/index.js';
import type { BusHost } from '../bus/index.js';
import {
  openDriverRound,
  type BuilderContext,
  type DriverRound,
} from '../driver/index.js';
import { GATE_EVENTS } from '../gate/index.js';
import { RESTART_REASON } from '../lifecycle/index.js';
import type { PauseGuard } from '../pause/index.js';
import {
  ROUND_ENDED_EVENT,
  cleanUpRound,
  startRoundAutoEnd,
  startRoundControl,
  type AutoEnd,
  type RoundControl,
} from '../round-end/index.js';
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
import { startRoundRun, type RoundRun } from './round-run.js';
import {
  activeRoundIds,
  roundEnded,
  roundIdOf,
  type OpenedRound,
} from './round-rows.js';
import { baseRef, type CrewRules } from './rules.js';
import type { CrewSessionHost } from './sessions.js';

export const DRIVER_FAILED_REASON = 'driver_failed';

export interface CrewRoundsOptions {
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

export interface CrewRounds {
  live: (roundId: string) => RoundRun | undefined;
  runs: () => RoundRun[];
  drain: () => Promise<void>;
  close: () => Promise<void>;
  idle: () => Promise<void>;
}

interface LiveRound {
  run: RoundRun;
  auto: AutoEnd;
}

export const startCrewRounds = async (
  options: CrewRoundsOptions,
): Promise<CrewRounds> => {
  const { store, lifecycle, report } = options;
  const live = new Map<string, LiveRound>();
  const launching = new Map<string, Promise<void>>();
  const tasks = new Set<Promise<void>>();
  const turnsDir = projectTurnsDir(options.project, options.home);
  let noting: Promise<void> = Promise.resolve();
  let closing = false;

  const track = (task: Promise<void>): void => {
    const tracked = task
      .catch(report('rounds'))
      .finally(() => tasks.delete(tracked));
    tasks.add(tracked);
  };

  const finish = (roundId: string): void => {
    const entry = live.get(roundId);
    if (!entry) return;
    live.delete(roundId);
    entry.run.close();
    entry.auto.close().catch(report('rounds', { roundId }));
  };

  const birthDriver = async (round: OpenedRound): Promise<DriverRound> => {
    const [models, charter, rules, repoPath] = await Promise.all([
      options.rules.load('models'),
      options.rules.load('charter'),
      options.rules.load('lifecycle'),
      options.rules.repoPath(),
    ]);
    const driver = await options.pause.hold(
      { operation: 'launch', label: `Driver, round ${round.number}` },
      () =>
        lifecycle.birth({
          store,
          role: 'driver',
          runtime: models.driver.runtime,
          roundId: round.id,
        }),
    );
    return openDriverRound({
      store,
      client: options.sessions.driverClient(driver.id),
      bus: options.bus,
      agentId: driver.id,
      roundId: round.id,
      cwd: repoPath,
      charter,
      turnsDir,
      budget: rules.budget.window,
      pause: options.pause,
    });
  };

  const builderContext = async (
    round: DriverRound,
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
      roundId: round.round.id,
    };
  };

  const run = async (round: DriverRound): Promise<void> => {
    const [charter, rules] = await Promise.all([
      options.rules.load('charter'),
      options.rules.load('lifecycle'),
    ]);
    const roundId = round.round.id;
    const builders = await builderContext(round);
    const auto = await startRoundAutoEnd({
      store,
      round,
      charter,
      lifecycle,
      settleSeconds: rules.autoEndSettleSeconds,
      home: options.home,
      onError: report('rounds', { roundId }),
    });
    const started = startRoundRun({ store, round, charter, builders, report });
    live.set(roundId, { run: started, auto });
    const waiting = await readWaitingTickets(store);
    if (waiting.length > 0) started.note(waitingTicketsNote(waiting));
    if (closing || (await roundEnded(store, roundId))) finish(roundId);
  };

  const launch = async (round: OpenedRound): Promise<void> => {
    const links = { roundId: round.id };
    options.reviewers.ensure().catch(report('reviewer', links));
    try {
      await run(await birthDriver(round));
    } catch (err) {
      if (closing) return;
      report('driver', links)(err);
      await cleanUpRound({
        store,
        lifecycle,
        roundId: round.id,
        reason: DRIVER_FAILED_REASON,
        reopen: true,
      }).catch(report('rounds', links));
    }
  };

  const endStaleRounds = async (): Promise<void> => {
    for (const roundId of await activeRoundIds(store)) {
      await cleanUpRound({
        store,
        lifecycle,
        roundId,
        reason: RESTART_REASON,
        reopen: true,
      }).catch(report('rounds', { roundId }));
    }
  };

  const runs = (): RoundRun[] => [...live.values()].map((entry) => entry.run);

  const noteEvent = (event: StoreEvent): void => {
    noting = noting
      .then(async () => {
        const active = runs();
        if (active.length === 0) return;
        const note = await noteForEvent(store, event);
        if (note) for (const target of active) target.note(note);
      })
      .catch(report('rounds'));
  };

  const onEvent = (event: StoreEvent): void => {
    if (event.kind === ROUND_ENDED_EVENT) {
      const roundId = roundIdOf(event);
      if (roundId !== undefined) finish(roundId);
      return;
    }
    if (event.kind === GATE_EVENTS.reported)
      options.reviewers.ensure().catch(report('reviewer'));
    if (DRIVER_NOTE_KINDS.includes(event.kind)) noteEvent(event);
  };

  await endStaleRounds();
  const subscription = await store.subscribe(onEvent, {
    onError: report('rounds'),
  });
  const control: RoundControl = await startRoundControl({
    store,
    lifecycle,
    driver: (roundId) => live.get(roundId)?.run.driver,
    onError: report('rounds'),
  });
  const intents: CrewIntents = await startCrewIntents({
    store,
    runs,
    report,
    start: (round) => {
      const launched = launch(round).finally(() => launching.delete(round.id));
      launching.set(round.id, launched);
      track(launched);
    },
    launched: async (roundId) => {
      await launching.get(roundId);
    },
    track,
  });

  return {
    live: (roundId) => live.get(roundId)?.run,
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
      for (const roundId of live.keys()) finish(roundId);
    },
    idle: async () => {
      while (tasks.size > 0) await Promise.allSettled(tasks);
      await noting;
    },
  };
};
