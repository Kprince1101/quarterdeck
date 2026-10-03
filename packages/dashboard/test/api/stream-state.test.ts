import type {
  AgentRow,
  NotebookRow,
  StreamEvent,
  StreamMessage,
  TurnRow,
} from '@quarterdeck/server/stream-schema';
import { describe, expect, it } from 'vitest';
import {
  applyStreamMessage,
  emptyTables,
  initialStreamState,
  type StreamLimits,
  type StreamState,
} from '../../src/api/index.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const OTHER_AGENT = '33333333-3333-4333-8333-333333333333';
const NOTE = '44444444-4444-4444-8444-444444444444';
const AT = '2026-10-01T12:00:00.000Z';

const LIMITS: StreamLimits = { events: 3, turnsPerAgent: 2 };

const agent = (id: string): AgentRow => ({
  id,
  projectId: PROJECT,
  voyageId: null,
  name: 'ibis',
  role: 'builder',
  runtime: 'claude',
  status: 'working',
  sessionId: null,
  worktreePath: null,
  createdAt: AT,
  updatedAt: AT,
  endedAt: null,
});

const turn = (id: number, agentId: string, seq: number): TurnRow => ({
  id,
  agentId,
  ticketId: null,
  seq,
  stopReason: null,
  inputTokens: 0,
  outputTokens: 0,
  transcriptPath: null,
  startedAt: AT,
  endedAt: null,
});

const note = (body: string): NotebookRow => ({
  id: NOTE,
  projectId: PROJECT,
  voyageId: null,
  authorId: null,
  body,
  pinned: false,
  createdAt: AT,
  retiredAt: null,
});

const event = (id: number): StreamEvent => ({
  id,
  projectId: PROJECT,
  agentId: null,
  ticketId: null,
  kind: 'notebook.add',
  payload: { intentId: NOTE, status: 'applied' },
  createdAt: AT,
});

const apply = (
  messages: StreamMessage[],
  state: StreamState = initialStreamState,
): StreamState =>
  messages.reduce(
    (current, message) => applyStreamMessage(current, message, LIMITS),
    state,
  );

const snapshot = (
  cursor: number,
  agents: AgentRow[] = [],
  pausedAt: string | null = null,
): StreamMessage => ({
  type: 'snapshot',
  cursor,
  tables: { ...emptyTables(), agents },
  machine: { pausedAt },
});

describe('stream state', () => {
  it('waits for a snapshot', () => {
    expect(initialStreamState).toMatchObject({
      status: 'connecting',
      cursor: null,
      events: [],
      error: null,
    });
    expect(Object.values(initialStreamState.tables).flat()).toEqual([]);
  });

  it('takes the snapshot tables and cursor, and goes live', () => {
    const state = apply([snapshot(7, [agent(AGENT)])], {
      ...initialStreamState,
      status: 'reconnecting',
      error: 'stream closed (1006)',
    });
    expect(state.status).toBe('live');
    expect(state.cursor).toBe(7);
    expect(state.error).toBeNull();
    expect(state.tables.agents).toEqual([agent(AGENT)]);
  });

  it('takes the machine pause from the snapshot and from machine messages', () => {
    expect(initialStreamState.machine).toEqual({ pausedAt: null });
    const paused = apply([snapshot(0, [], AT)]);
    expect(paused.machine).toEqual({ pausedAt: AT });
    const resumed = apply(
      [{ type: 'machine', machine: { pausedAt: null } }],
      paused,
    );
    expect(resumed.machine).toEqual({ pausedAt: null });
    expect(resumed.tables).toBe(paused.tables);
    expect(resumed.cursor).toBe(paused.cursor);
  });

  it('appends events in order, advances the cursor and keeps the newest', () => {
    const state = apply([
      snapshot(0),
      ...[1, 2, 3, 4].map((id) => ({
        type: 'event' as const,
        event: event(id),
      })),
    ]);
    expect(state.cursor).toBe(4);
    expect(state.events.map(({ id }) => id)).toEqual([2, 3, 4]);
  });

  it('drops an event it has already handled', () => {
    const live = apply([snapshot(0), { type: 'event', event: event(1) }]);
    const again = apply(
      [snapshot(1), { type: 'event', event: event(1) }],
      live,
    );
    expect(again.events.map(({ id }) => id)).toEqual([1]);
  });

  it('upserts a changed row by id and removes a deleted one', () => {
    const inserted = apply([
      snapshot(0),
      {
        type: 'change',
        table: 'notebook',
        op: 'insert',
        id: NOTE,
        row: note('first'),
      },
      {
        type: 'change',
        table: 'notebook',
        op: 'update',
        id: NOTE,
        row: note('second'),
      },
    ]);
    expect(inserted.tables.notebook).toEqual([note('second')]);
    const deleted = apply(
      [
        {
          type: 'change',
          table: 'notebook',
          op: 'delete',
          id: NOTE,
          row: null,
        },
      ],
      inserted,
    );
    expect(deleted.tables.notebook).toEqual([]);
  });

  it('drops a deleted agent’s turns, which get no deletes of their own', () => {
    const state = apply([
      snapshot(0, [agent(AGENT), agent(OTHER_AGENT)]),
      {
        type: 'change',
        table: 'turns',
        op: 'insert',
        id: 1,
        row: turn(1, AGENT, 1),
      },
      {
        type: 'change',
        table: 'turns',
        op: 'insert',
        id: 2,
        row: turn(2, OTHER_AGENT, 1),
      },
      { type: 'change', table: 'agents', op: 'delete', id: AGENT, row: null },
    ]);
    expect(state.tables.agents).toEqual([agent(OTHER_AGENT)]);
    expect(state.tables.turns).toEqual([turn(2, OTHER_AGENT, 1)]);
  });

  it('keeps only each agent’s latest turns, like the snapshot', () => {
    const state = apply([
      snapshot(0),
      ...[1, 2, 3].map((seq) => ({
        type: 'change' as const,
        table: 'turns' as const,
        op: 'insert' as const,
        id: seq,
        row: turn(seq, AGENT, seq),
      })),
      {
        type: 'change',
        table: 'turns',
        op: 'insert',
        id: 4,
        row: turn(4, OTHER_AGENT, 1),
      },
    ]);
    expect(state.tables.turns).toEqual([
      turn(2, AGENT, 2),
      turn(3, AGENT, 3),
      turn(4, OTHER_AGENT, 1),
    ]);
  });
});
