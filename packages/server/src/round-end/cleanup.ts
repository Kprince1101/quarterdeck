import {
  DISCARD_WORKTREE_CARD,
  WorktreeDirtyError,
  findAgent,
  requestWorktreeDiscard,
  type AgentLifecycle,
} from '../agents/index.js';
import {
  ACTIVE_TICKET_STATUSES,
  APPROVED_TICKET_STATUS,
  RoundNotFoundError,
} from '../driver/index.js';
import {
  publishEvent,
  type PublishInput,
  type Queryable,
  type Store,
} from '../store/index.js';

export const ROUND_ENDED_EVENT = 'round.ended';
export const CARD_EXPIRED_EVENT = 'card.expired';
export const TICKET_REOPENED_EVENT = 'ticket.reopened';

export const ROUND_AGENT_ROLES: readonly string[] = ['driver', 'builder'];

const BUILDER_ROLES: readonly string[] = ['builder'];
const DRIVER_ROLES: readonly string[] = ['driver'];

export interface CleanUpOptions {
  store: Store;
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  roundId: string;
  reason: string;
  reopen?: boolean;
}

export interface RoundRelease {
  closedCards: string[];
  retired: string[];
  discardCards: string[];
}

export interface RoundCleanup extends RoundRelease {
  roundId: string;
  round: number;
  ended: boolean;
  reopened: string[];
}

interface ClosedCard {
  id: string;
  agentId: string | null;
  ticketId: string | null;
}

interface ReopenedTicket {
  id: string;
  previousStatus: string;
  previousAssigneeId: string;
}

const ROUND_BUILDERS = `select id from agents
  where project_id = $1 and round_id = $2 and role = 'builder'`;

const roundAgents = async (
  store: Store,
  roundId: string,
  roles: readonly string[],
): Promise<string[]> => {
  const { rows } = await store.db.query<{ id: string }>(
    `select a.id from agents a
     where a.project_id = $1 and a.round_id = $2 and a.role = any($3::text[])
       and a.status <> 'retired'
       and not exists (
         select 1 from cards c
         where c.agent_id = a.id and c.kind = $4 and c.status = 'open'
       )
     order by a.created_at, a.id`,
    [store.projectId, roundId, roles, DISCARD_WORKTREE_CARD],
  );
  return rows.map((row) => row.id);
};

export const readRoundNumber = async (
  db: Queryable,
  projectId: string,
  roundId: string,
): Promise<number> => {
  const { rows } = await db.query<{ number: number }>(
    'select number from rounds where id = $1 and project_id = $2',
    [roundId, projectId],
  );
  const [round] = rows;
  if (!round) throw new RoundNotFoundError(roundId);
  return round.number;
};

const cardExpired = (
  card: ClosedCard,
  roundId: string,
  reason: string,
): PublishInput => {
  const event: PublishInput = {
    kind: CARD_EXPIRED_EVENT,
    payload: { cardId: card.id, roundId, reason },
  };
  if (card.agentId !== null) event.agentId = card.agentId;
  if (card.ticketId !== null) event.ticketId = card.ticketId;
  return event;
};

const publishClosed = async (
  tx: Queryable,
  projectId: string,
  cards: readonly ClosedCard[],
  roundId: string,
  reason: string,
): Promise<string[]> => {
  for (const card of cards) {
    await publishEvent(tx, projectId, cardExpired(card, roundId, reason));
  }
  return cards.map((card) => card.id);
};

export const closeRoundCards = (
  store: Store,
  roundId: string,
  reason: string,
): Promise<string[]> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<ClosedCard>(
      `update cards set status = 'expired'
       where project_id = $1 and status = 'open' and kind <> $4
         and agent_id in (
           select id from agents
           where project_id = $1 and round_id = $2 and role = any($3::text[])
         )
       returning id, agent_id as "agentId", ticket_id as "ticketId"`,
      [store.projectId, roundId, ROUND_AGENT_ROLES, DISCARD_WORKTREE_CARD],
    );
    return publishClosed(tx, store.projectId, rows, roundId, reason);
  });

const retireOrAsk = async (
  options: CleanUpOptions,
  agentId: string,
): Promise<{ retired?: string; discardCard?: string }> => {
  try {
    await options.lifecycle.retire(options.store, agentId);
    return { retired: agentId };
  } catch (err) {
    if (!(err instanceof WorktreeDirtyError)) throw err;
    const agent = await findAgent(options.store, agentId);
    return {
      discardCard: await requestWorktreeDiscard(options.store, agent, err),
    };
  }
};

const retireRoundAgents = async (
  options: CleanUpOptions,
  roles: readonly string[],
): Promise<Pick<RoundRelease, 'retired' | 'discardCards'>> => {
  const retired: string[] = [];
  const discardCards: string[] = [];
  for (const agentId of await roundAgents(
    options.store,
    options.roundId,
    roles,
  )) {
    const step = await retireOrAsk(options, agentId);
    if (step.retired !== undefined) retired.push(step.retired);
    if (step.discardCard !== undefined) discardCards.push(step.discardCard);
  }
  return { retired, discardCards };
};

export const releaseRound = async (
  options: CleanUpOptions,
): Promise<RoundRelease> => {
  const { store, roundId, reason } = options;
  await readRoundNumber(store.db, store.projectId, roundId);
  const closedCards = await closeRoundCards(store, roundId, reason);
  return { closedCards, ...(await retireRoundAgents(options, BUILDER_ROLES)) };
};

const reopenTickets = async (
  tx: Queryable,
  options: CleanUpOptions,
): Promise<string[]> => {
  const { store, roundId, reason } = options;
  const { rows } = await tx.query<ReopenedTicket>(
    `with held as (
       select id, status, assignee_id from tickets
       where project_id = $1 and status = any($3::text[])
         and assignee_id in (${ROUND_BUILDERS})
       for update
     )
     update tickets t set status = $4, assignee_id = null
     from held
     where t.id = held.id
     returning t.id, held.status as "previousStatus",
       held.assignee_id as "previousAssigneeId"`,
    [store.projectId, roundId, ACTIVE_TICKET_STATUSES, APPROVED_TICKET_STATUS],
  );
  for (const ticket of rows) {
    await publishEvent(tx, store.projectId, {
      kind: TICKET_REOPENED_EVENT,
      agentId: ticket.previousAssigneeId,
      ticketId: ticket.id,
      payload: {
        roundId,
        previousStatus: ticket.previousStatus,
        previousAssigneeId: ticket.previousAssigneeId,
      },
    });
  }
  const ids = rows.map((ticket) => ticket.id);
  const closed = await tx.query<ClosedCard>(
    `update cards set status = 'expired'
     where project_id = $1 and status = 'open' and ticket_id = any($2::uuid[])
     returning id, agent_id as "agentId", ticket_id as "ticketId"`,
    [store.projectId, ids],
  );
  await publishClosed(tx, store.projectId, closed.rows, roundId, reason);
  return ids;
};

const markEnded = (
  options: CleanUpOptions,
  cleanup: Omit<RoundCleanup, 'ended' | 'reopened'>,
): Promise<Pick<RoundCleanup, 'ended' | 'reopened'>> =>
  options.store.db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `update rounds set status = 'ended', ended_at = now()
       where id = $1 and project_id = $2 and status <> 'ended'
       returning id`,
      [options.roundId, options.store.projectId],
    );
    if (rows.length === 0) return { ended: false, reopened: [] };
    let reopened: string[] = [];
    if (options.reopen === true) reopened = await reopenTickets(tx, options);
    await publishEvent(tx, options.store.projectId, {
      kind: ROUND_ENDED_EVENT,
      payload: { ...cleanup, reason: options.reason, reopened },
    });
    return { ended: true, reopened };
  });

export const cleanUpRound = async (
  options: CleanUpOptions,
): Promise<RoundCleanup> => {
  const { store, roundId } = options;
  const round = await readRoundNumber(store.db, store.projectId, roundId);
  const released = await releaseRound(options);
  const drivers = await retireRoundAgents(options, DRIVER_ROLES);
  const cleanup = {
    roundId,
    round,
    closedCards: released.closedCards,
    retired: [...released.retired, ...drivers.retired],
    discardCards: [...released.discardCards, ...drivers.discardCards],
  };
  return { ...cleanup, ...(await markEnded(options, cleanup)) };
};
