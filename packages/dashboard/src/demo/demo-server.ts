import type { WipeResult } from '@quarterdeck/server/intents';
import type {
  VoyageRow,
  Workspace,
  WorkspaceMode,
} from '@quarterdeck/server/stream-schema';
import { createIntentClient } from '../api/intents.js';
import { createRulesReader } from '../api/rules.js';
import type { DeckSources } from '../deck/DeckProvider.js';
import { DEMO_ORIGIN, demoFetch } from './demo-fetch.js';
import { createDemoIntents } from './demo-intents.js';
import { createDemoKeepAwake } from './demo-keep-awake.js';
import { createDemoPlanner } from './demo-planner.js';
import { createDemoReads, DEMO_REPO_PATH } from './demo-reads.js';
import { createDemoRules, shippedRule } from './demo-rules.js';
import {
  planOf,
  voyageBeats,
  type DemoBeat,
  type DemoScriptOptions,
} from './demo-script.js';
import {
  DEMO_LIFECYCLE,
  DEMO_PROJECT,
  PLANNER_ASK,
  seedProject,
} from './demo-seed.js';
import { demoWebSocket } from './demo-socket.js';
import { createDemoStore, demoId, type DemoStore } from './demo-store.js';
import { createDemoWorld, type DemoWorld } from './demo-world.js';

export const DEMO_BEAT_MS = 2500;

export const BEATS_BETWEEN_VOYAGES = 4;

export const DEMO_STREAM_URL = 'ws://demo.quarterdeck.invalid/ws';

const SEED_LAG_MS = 45 * 60 * 1000;

const SEED_BEAT_MS = 75 * 1000;

const SEEDED_LIVE_BEATS = 4;

export interface DemoServerOptions {
  now?: () => number;
  workspace?: WorkspaceMode;
}

const demoWorkspace = (
  mode: WorkspaceMode | undefined,
  now: number,
): Workspace | null => {
  if (mode !== 'single') return null;
  return {
    root: DEMO_REPO_PATH,
    mode,
    projects: [
      {
        slug: DEMO_PROJECT,
        name: 'Harbor',
        repoPath: DEMO_REPO_PATH,
        repository: 'github.com/demo/harbor',
      },
    ],
    updatedAt: new Date(now).toISOString(),
  };
};

export interface DemoServer {
  store: DemoStore;
  world: DemoWorld;
  sources: DeckSources;
  step: () => void;
  start: (beatMs?: number) => void;
  stop: () => void;
}

const namesOf = (): string[] =>
  (JSON.parse(shippedRule('naming')) as { names: string[] }).names;

interface Director {
  voyage: string | null;
  beats: DemoBeat[];
  at: number;
  idle: number;
}

const playBeat = (director: Director): void => {
  while (director.at < director.beats.length) {
    const beat = director.beats[director.at];
    director.at += 1;
    if (beat?.() === true) return;
  }
};

export const createDemoServer = (
  options: DemoServerOptions = {},
): DemoServer => {
  const clock = options.now ?? Date.now;
  let lag = 0;
  const store = createDemoStore({
    projectId: demoId(0),
    now: () => clock() - lag,
    workspace: demoWorkspace(options.workspace, clock()),
  });
  const world = createDemoWorld(store);
  const rules = createDemoRules({ lifecycle: DEMO_LIFECYCLE });
  const planner = createDemoPlanner(world);
  const reads = createDemoReads(world, rules);
  const script: DemoScriptOptions = { names: namesOf() };
  const director: Director = { voyage: null, beats: [], at: 0, idle: 0 };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let interval: ReturnType<typeof setInterval> | undefined;

  const adopt = (voyage: VoyageRow, scriptOptions: DemoScriptOptions): void => {
    director.voyage = voyage.id;
    director.beats = voyageBeats(world, voyage, scriptOptions);
    director.at = 0;
    director.idle = 0;
  };

  const isHeld = (): boolean =>
    store.machine().pausedAt !== null ||
    store
      .rows('projects')
      .some(
        (project) => project.pausedAt !== null || project.archivedAt !== null,
      );

  const step = (): void => {
    if (isHeld()) return;
    const open = world.openVoyage();
    if (open === undefined) {
      director.idle += 1;
      if (director.idle < BEATS_BETWEEN_VOYAGES) return;
      const next = store.rows('voyages').length + 1;
      adopt(world.startVoyage(planOf(next).goal), script);
      return;
    }
    if (director.voyage !== open.id) adopt(open, script);
    playBeat(director);
  };

  const later = (ms: number, work: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      work();
    }, ms);
    timers.add(timer);
  };

  const clearTimers = (): void => {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
  };

  const seed = (): void => {
    lag = SEED_LAG_MS;
    const tick = (): void => {
      lag = Math.max(0, lag - SEED_BEAT_MS);
    };
    seedProject(world);
    const first = world.startVoyage(planOf(1).goal);
    adopt(first, { ...script, answerCards: true });
    while (world.openVoyage() !== undefined) {
      playBeat(director);
      tick();
    }
    planner.reply(planner.hear(store.newId(), PLANNER_ASK), PLANNER_ASK);
    tick();
    adopt(world.startVoyage(planOf(2).goal), script);
    Array.from({ length: SEEDED_LIVE_BEATS }).forEach(() => {
      playBeat(director);
      tick();
    });
    lag = 0;
  };
  seed();

  const keepAwake = createDemoKeepAwake({ store, later });

  const wipe = (): WipeResult => {
    const stopped = store
      .rows('agents')
      .filter((agent) => !world.isGone(agent))
      .map((agent) => ({ project: DEMO_PROJECT, agent: agent.name }));
    clearTimers();
    store.reset();
    keepAwake.stop();
    world.turnText.clear();
    seed();
    return { wiped: [DEMO_PROJECT], stopped };
  };

  const intent = createDemoIntents({
    world,
    rules,
    planner,
    reads,
    startVoyage: (goal) => world.startVoyage(goal),
    later,
    wipe,
    keepAwake,
  });
  const fetch = demoFetch({
    intent,
    rules: (project) => rules.view(project, DEMO_REPO_PATH),
  });

  return {
    store,
    world,
    sources: {
      stream: { url: DEMO_STREAM_URL, WebSocket: demoWebSocket(store) },
      intents: createIntentClient({ baseUrl: DEMO_ORIGIN, fetch }),
      rules: createRulesReader({ baseUrl: DEMO_ORIGIN, fetch }),
    },
    step,
    start: (beatMs = DEMO_BEAT_MS) => {
      clearInterval(interval);
      interval = setInterval(step, beatMs);
    },
    stop: () => {
      clearInterval(interval);
      interval = undefined;
      clearTimers();
    },
  };
};
