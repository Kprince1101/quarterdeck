import type {
  DataPage,
  DataPathEntry,
  DataSummary,
  TurnReadResult,
  UsageReadResult,
} from '@quarterdeck/server/intents';
import { mergeLayer } from '@quarterdeck/rules/merge';
import { lifecycleSchema, type Lifecycle } from '@quarterdeck/rules/schemas';
import { STREAM_TABLES, type TurnRow } from '@quarterdeck/server/stream-schema';
import { DemoRefusal } from './demo-fetch.js';
import { DEMO_HOME, shippedRule, type DemoRules } from './demo-rules.js';
import {
  DEMO_TURNS_DIR,
  DEMO_WORKTREES,
  type DemoWorld,
} from './demo-world.js';

const NOT_FOUND = 404;
const PERCENT = 100;

export const DEMO_REPO_PATH = '/home/demo/harbor';

const DATA_DIR = `${DEMO_HOME}/.quarterdeck`;

const DEMO_PATHS: DataPathEntry[] = [
  {
    label: 'Data folder',
    path: DATA_DIR,
    kind: 'directory',
    scope: 'machine',
    exists: true,
  },
  {
    label: 'Database',
    path: `${DATA_DIR}/harbor/pgdata`,
    kind: 'database',
    scope: 'project',
    exists: true,
  },
  {
    label: 'Transcripts',
    path: DEMO_TURNS_DIR,
    kind: 'directory',
    scope: 'project',
    exists: true,
  },
  {
    label: 'Worktrees',
    path: DEMO_WORKTREES,
    kind: 'directory',
    scope: 'repo',
    exists: true,
  },
];

export interface DemoReads {
  summary: () => DataSummary;
  page: (table: string, offset: number, limit: number) => DataPage;
  turn: (turnId: number) => TurnReadResult;
  usage: () => UsageReadResult;
}

const percentOf = (used: number, cap: number | null): number | null => {
  if (cap === null) return null;
  return (used / cap) * PERCENT;
};

interface DriverPlace {
  round: number | null;
  n: number | null;
}

const driverPlace = (world: DemoWorld, turn: TurnRow): DriverPlace => {
  const { store } = world;
  const agent = store.find('agents', turn.agentId);
  if (agent?.role !== 'driver' || agent.roundId === null) {
    return { round: null, n: null };
  }
  const round = store.find('rounds', agent.roundId);
  const drivers = new Set(
    store
      .rows('agents')
      .filter((row) => row.role === 'driver' && row.roundId === agent.roundId)
      .map((row) => row.id),
  );
  const turns = store
    .rows('turns')
    .filter((row) => drivers.has(row.agentId))
    .map((row) => row.id);
  return { round: round?.number ?? null, n: turns.indexOf(turn.id) + 1 };
};

const lifecycleOf = (rules: DemoRules): Lifecycle => {
  const defaults = lifecycleSchema.parse(JSON.parse(shippedRule('lifecycle')));
  try {
    const machine: unknown = JSON.parse(rules.content('lifecycle'));
    return lifecycleSchema.parse(mergeLayer(defaults, machine));
  } catch {
    return defaults;
  }
};

export const createDemoReads = (
  world: DemoWorld,
  rules: DemoRules,
): DemoReads => {
  const { store } = world;
  const tableRows = (table: string): Record<string, unknown>[] => {
    if (table === 'events') return [...store.events()];
    if (!(STREAM_TABLES as string[]).includes(table)) {
      throw new DemoRefusal(NOT_FOUND, `No table ${table}`);
    }
    return store.rows(table as (typeof STREAM_TABLES)[number]);
  };

  return {
    summary: () => ({
      backend: 'pglite',
      tables: [...STREAM_TABLES, 'events'].map((table) => ({
        table,
        rows: tableRows(table).length,
      })),
      paths: DEMO_PATHS,
    }),
    page: (table, offset, limit) => {
      const rows = tableRows(table);
      const columns = Object.keys(rows[0] ?? {});
      return {
        table,
        offset,
        limit,
        total: rows.length,
        columns,
        rows: rows
          .slice(offset, offset + limit)
          .map((row) =>
            columns.map((column) => row[column] ?? null),
          ) as DataPage['rows'],
      };
    },
    turn: (turnId) => {
      const turn = store.rows('turns').find((row) => row.id === turnId);
      if (turn === undefined) {
        throw new DemoRefusal(NOT_FOUND, `turn ${turnId} not found`);
      }
      const text = world.turnText.get(turn.id);
      return {
        turnId: turn.id,
        agentId: turn.agentId,
        seq: turn.seq,
        input: text?.input ?? '',
        output: text?.output ?? null,
        result: { stopReason: turn.stopReason },
        ...driverPlace(world, turn),
        latestSession: true,
      };
    },
    usage: () => {
      const { window } = lifecycleOf(rules).budget;
      const rounds = store
        .rows('rounds')
        .toSorted((a, b) => b.number - a.number);
      const opens = rounds[1]?.startedAt ?? '';
      const usedTokens = store
        .rows('turns')
        .filter((turn) => (turn.endedAt ?? '') >= opens)
        .reduce((sum, turn) => sum + turn.inputTokens + turn.outputTokens, 0);
      return {
        windowHours: window.hours,
        usedTokens,
        capTokens: window.capTokens,
        percent: percentOf(usedTokens, window.capTokens),
      };
    },
  };
};
