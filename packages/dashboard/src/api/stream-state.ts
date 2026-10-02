import {
  STREAM_TABLES,
  type ChangeMessage,
  type SnapshotTables,
  type StreamEvent,
  type StreamMessage,
  type TurnRow,
} from '@quarterdeck/server/stream-schema';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface StreamState {
  status: StreamStatus;
  cursor: number | null;
  tables: SnapshotTables;
  events: readonly StreamEvent[];
  error: string | null;
}

export interface StreamLimits {
  events: number;
  turnsPerAgent: number;
}

export const STREAM_EVENT_LIMIT = 500;

export const STREAM_TURNS_PER_AGENT = 20;

export const DEFAULT_STREAM_LIMITS: StreamLimits = {
  events: STREAM_EVENT_LIMIT,
  turnsPerAgent: STREAM_TURNS_PER_AGENT,
};

interface Keyed {
  id: string | number;
}

export const emptyTables = (): SnapshotTables =>
  Object.fromEntries(
    STREAM_TABLES.map((table) => [table, []]),
  ) as unknown as SnapshotTables;

export const initialStreamState: StreamState = {
  status: 'connecting',
  cursor: null,
  tables: emptyTables(),
  events: [],
  error: null,
};

const upsert = (
  rows: readonly Keyed[],
  id: string | number,
  row: Keyed | null,
): Keyed[] => {
  const index = rows.findIndex((existing) => existing.id === id);
  if (row === null) return rows.filter((_, at) => at !== index);
  if (index === -1) return [...rows, row];
  return rows.with(index, row);
};

const latestTurns = (
  turns: TurnRow[],
  agentId: string,
  limit: number,
): TurnRow[] => {
  const mine = turns.filter((turn) => turn.agentId === agentId);
  if (mine.length <= limit) return turns;
  const kept = new Set(mine.toSorted((a, b) => b.seq - a.seq).slice(0, limit));
  return turns.filter((turn) => turn.agentId !== agentId || kept.has(turn));
};

const applyChange = (
  tables: SnapshotTables,
  change: ChangeMessage,
  limits: StreamLimits,
): SnapshotTables => {
  const rows = upsert(tables[change.table], change.id, change.row);
  const next = { ...tables, [change.table]: rows } as SnapshotTables;
  if (change.table === 'agents' && change.row === null) {
    next.turns = next.turns.filter((turn) => turn.agentId !== change.id);
  }
  if (change.table === 'turns' && change.row !== null) {
    const { agentId } = change.row as TurnRow;
    next.turns = latestTurns(next.turns, agentId, limits.turnsPerAgent);
  }
  return next;
};

const applyEvent = (
  state: StreamState,
  event: StreamEvent,
  limits: StreamLimits,
): StreamState => {
  if (state.cursor !== null && event.id <= state.cursor) return state;
  return {
    ...state,
    cursor: event.id,
    events: [...state.events, event].slice(-limits.events),
  };
};

export const applyStreamMessage = (
  state: StreamState,
  message: StreamMessage,
  limits: StreamLimits = DEFAULT_STREAM_LIMITS,
): StreamState => {
  switch (message.type) {
    case 'snapshot': {
      return {
        ...state,
        status: 'live',
        cursor: message.cursor,
        tables: message.tables,
        error: null,
      };
    }
    case 'event': {
      return applyEvent(state, message.event, limits);
    }
    case 'change': {
      return {
        ...state,
        tables: applyChange(state.tables, message, limits),
      };
    }
  }
};
