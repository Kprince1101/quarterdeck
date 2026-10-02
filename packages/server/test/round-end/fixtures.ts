import type { Scheduler } from '../../src/round-end/index.js';
import type { SessionHost } from '../../src/agents/index.js';
import type { Store } from '../../src/store/index.js';

export const TIMEOUT = 30_000;

export interface FakeTimer {
  ms: number;
  fire: () => void;
  cancelled: boolean;
}

export interface FakeScheduler {
  schedule: Scheduler;
  timers: FakeTimer[];
  live: () => FakeTimer[];
}

export const fakeScheduler = (): FakeScheduler => {
  const timers: FakeTimer[] = [];
  const schedule: Scheduler = (ms, fire) => {
    const timer: FakeTimer = { ms, fire, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return {
    schedule,
    timers,
    live: () => timers.filter((timer) => !timer.cancelled),
  };
};

export const lenientSessions = (): SessionHost & { closed: string[] } => {
  const closed: string[] = [];
  return {
    closed,
    open: async (agent) => `session-${agent.name}`,
    close: async (sessionId) => {
      closed.push(sessionId);
    },
  };
};

export const insertRound = async (
  store: Store,
  number: number,
  status = 'active',
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into rounds (project_id, number, status, goal)
     values ($1, $2, $3, 'Ship the round end.') returning id`,
    [store.projectId, number, status],
  );
  return rows[0]?.id ?? '';
};

export interface AgentSeed {
  name: string;
  role?: string;
  status?: string;
  roundId?: string | null;
  sessionId?: string | null;
  worktreePath?: string | null;
}

export const insertAgent = async (
  store: Store,
  seed: AgentSeed,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into agents
       (project_id, name, role, status, round_id, session_id, worktree_path)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      store.projectId,
      seed.name,
      seed.role ?? 'builder',
      seed.status ?? 'idle',
      seed.roundId ?? null,
      seed.sessionId ?? null,
      seed.worktreePath ?? null,
    ],
  );
  return rows[0]?.id ?? '';
};

export const insertTicket = async (
  store: Store,
  status: string,
  assigneeId: string | null = null,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into tickets (project_id, title, status, assignee_id)
     values ($1, 'QD5f', $2, $3) returning id`,
    [store.projectId, status, assigneeId],
  );
  return rows[0]?.id ?? '';
};

export interface CardSeed {
  agentId?: string;
  ticketId?: string;
  kind?: string;
  status?: string;
}

export const insertCard = async (
  store: Store,
  seed: CardSeed = {},
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into cards (project_id, agent_id, ticket_id, kind, status, question)
     values ($1, $2, $3, $4, $5, 'Ship it?') returning id`,
    [
      store.projectId,
      seed.agentId ?? null,
      seed.ticketId ?? null,
      seed.kind ?? 'question',
      seed.status ?? 'open',
    ],
  );
  return rows[0]?.id ?? '';
};

export const eventPayloads = async (
  store: Store,
  kind: string,
): Promise<Record<string, unknown>[]> => {
  const { rows } = await store.db.query<{
    payload: Record<string, unknown>;
  }>(
    'select payload from events where project_id = $1 and kind = $2 order by id',
    [store.projectId, kind],
  );
  return rows.map((row) => row.payload);
};

export const CLEAR_ROUND_TABLES = `delete from events; delete from turns;
  delete from notebook_proposals; delete from charter_proposals;
  delete from notebook; delete from cards; delete from tickets;
  delete from agents; delete from rounds;`;
