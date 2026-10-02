import {
  AGENT_COLUMNS,
  sweepAgentProcess,
  type Agent,
  type SweepOutcome,
} from '../agents/index.js';
import { expireOverdueCards } from '../bus/cards.js';
import {
  publishEvent,
  type PublishInput,
  type Queryable,
  type Store,
} from '../store/index.js';

export const RESTART_REASON = 'restart';

export const PAUSE_HELD_EVENT = 'pause.held';
export const PAUSE_DROPPED_EVENT = 'pause.dropped';
const PAUSE_SETTLED_EVENTS = ['pause.replayed', PAUSE_DROPPED_EVENT];

export interface ReapedAgent {
  agentId: string;
  name: string;
  outcome: SweepOutcome;
}

export interface Recovery {
  reaped: ReapedAgent[];
  expiredCards: string[];
  droppedPauses: number[];
}

export interface RecoverOptions {
  killGraceMs?: number;
}

interface OrphanedHold {
  id: number;
  agentId: string | null;
  ticketId: string | null;
  operation: string | null;
  label: string | null;
}

const agentsWithProcesses = async (store: Store): Promise<Agent[]> => {
  const { rows } = await store.db.query<Agent>(
    `select ${AGENT_COLUMNS} from agents
     where project_id = $1 and pid is not null
     order by created_at, id`,
    [store.projectId],
  );
  return rows;
};

export const reapAgentProcesses = async (
  store: Store,
  options: RecoverOptions = {},
): Promise<ReapedAgent[]> => {
  const reaped: ReapedAgent[] = [];
  for (const agent of await agentsWithProcesses(store)) {
    const outcome = await sweepAgentProcess(
      store,
      agent,
      RESTART_REASON,
      options.killGraceMs,
    );
    reaped.push({ agentId: agent.id, name: agent.name, outcome });
  }
  return reaped;
};

const orphanedHolds = async (
  tx: Queryable,
  projectId: string,
): Promise<OrphanedHold[]> => {
  const { rows } = await tx.query<OrphanedHold>(
    `select h.id, h.agent_id as "agentId", h.ticket_id as "ticketId",
       h.payload ->> 'operation' as operation, h.payload ->> 'label' as label
     from events h
     where h.project_id = $1 and h.kind = $2
       and not exists (
         select 1 from events s
         where s.project_id = $1 and s.kind = any($3::text[])
           and s.payload ->> 'heldEventId' = h.id::text
       )
     order by h.id`,
    [projectId, PAUSE_HELD_EVENT, PAUSE_SETTLED_EVENTS],
  );
  return rows;
};

const droppedEvent = (hold: OrphanedHold): PublishInput => {
  const event: PublishInput = {
    kind: PAUSE_DROPPED_EVENT,
    payload: {
      operation: hold.operation,
      label: hold.label,
      heldEventId: hold.id,
      reason: RESTART_REASON,
    },
  };
  if (hold.agentId !== null) event.agentId = hold.agentId;
  if (hold.ticketId !== null) event.ticketId = hold.ticketId;
  return event;
};

export const dropOrphanedPauses = (store: Store): Promise<number[]> =>
  store.db.transaction(async (tx) => {
    const holds = await orphanedHolds(tx, store.projectId);
    for (const hold of holds) {
      await publishEvent(tx, store.projectId, droppedEvent(hold));
    }
    return holds.map((hold) => hold.id);
  });

export const recoverProject = async (
  store: Store,
  options: RecoverOptions = {},
): Promise<Recovery> => ({
  reaped: await reapAgentProcesses(store, options),
  expiredCards: await expireOverdueCards(store, RESTART_REASON),
  droppedPauses: await dropOrphanedPauses(store),
});
