import { TICKET_BLOCKED_EVENT } from '../agents/index.js';
import {
  publishEvent,
  type PublishInput,
  type Queryable,
  type Store,
} from '../store/index.js';
import {
  TICKET_PUBLISHED_EVENT,
  dependencyLabel,
  dependencyPayload,
  readyText,
  unmetDependencies,
  type Dependency,
  type DependencyResolver,
  type Published,
} from './dependencies.js';
import {
  TicketNotBlockableError,
  TicketNotPublishableError,
} from './errors.js';
import { TICKET_COLUMNS, type BuilderTicket } from './tickets.js';

export { TICKET_BLOCKED_EVENT, TICKET_PUBLISHED_EVENT };

export const TICKET_WAITING_EVENT = 'ticket.waiting';
export const TICKET_UNBLOCKED_EVENT = 'ticket.unblocked';
export const DEPENDENCIES_REASON = 'dependencies';

export const BLOCKABLE_TICKET_STATUSES: readonly string[] = [
  'assigned',
  'in_progress',
  'in_review',
  'bounced',
];

const MARK_EVENTS: readonly string[] = [
  TICKET_WAITING_EVENT,
  TICKET_UNBLOCKED_EVENT,
];

type HoldStore = Pick<Store, 'db' | 'projectId'>;

export interface BlockRequest {
  ticketId: string;
  on: readonly string[];
  note?: string | undefined;
}

export interface Block {
  ticket: BuilderTicket;
  previousStatus: string;
  dependencies: Dependency[];
}

export interface PublishedRequest extends Published {
  ticketId: string;
}

export interface HeldTicket extends BuilderTicket {
  previousStatus: string;
}

export interface DependentTicket extends BuilderTicket {
  waiting: boolean;
}

const lockTicket = async (
  tx: Queryable,
  projectId: string,
  ticketId: string,
): Promise<BuilderTicket | undefined> => {
  const { rows } = await tx.query<BuilderTicket>(
    `select ${TICKET_COLUMNS} from tickets
     where id = $1 and project_id = $2 for update`,
    [ticketId, projectId],
  );
  return rows[0];
};

const builderName = async (
  tx: Queryable,
  agentId: string,
): Promise<string | null> => {
  const { rows } = await tx.query<{ name: string }>(
    'select name from agents where id = $1',
    [agentId],
  );
  return rows[0]?.name ?? null;
};

const blockRefusal = (
  ticket: BuilderTicket | undefined,
): string | undefined => {
  if (ticket === undefined) return 'it is not in this project';
  if (ticket.assigneeId === null)
    return 'no builder holds it; an unassigned ticket waits on its dependencies by itself';
  if (!BLOCKABLE_TICKET_STATUSES.includes(ticket.status))
    return `it is ${ticket.status}`;
  return undefined;
};

export const blockTicket = async (
  store: HoldStore,
  dependencies: DependencyResolver,
  request: BlockRequest,
): Promise<Block> => {
  const { ticketId } = request;
  if (request.on.includes(ticketId))
    throw new TicketNotBlockableError(
      ticketId,
      'a ticket cannot wait on itself',
    );
  const resolved = await dependencies(request.on);
  if (unmetDependencies(resolved).length === 0)
    throw new TicketNotBlockableError(
      ticketId,
      'everything it would wait on is already satisfied',
    );
  return store.db.transaction(async (tx) => {
    const ticket = await lockTicket(tx, store.projectId, ticketId);
    const refusal = blockRefusal(ticket);
    if (ticket === undefined || ticket.assigneeId === null || refusal)
      throw new TicketNotBlockableError(ticketId, refusal ?? 'it changed');
    const { rows } = await tx.query<BuilderTicket>(
      `update tickets
       set status = 'blocked',
           depends_on = depends_on || array(
             select d from unnest($3::uuid[]) d where d <> all(depends_on))
       where id = $1 and project_id = $2
       returning ${TICKET_COLUMNS}`,
      [ticketId, store.projectId, request.on],
    );
    const [blocked] = rows;
    if (blocked === undefined)
      throw new TicketNotBlockableError(ticketId, 'it changed');
    await publishEvent(tx, store.projectId, {
      kind: TICKET_BLOCKED_EVENT,
      agentId: ticket.assigneeId,
      ticketId,
      payload: {
        name: await builderName(tx, ticket.assigneeId),
        previousStatus: ticket.status,
        reason: DEPENDENCIES_REASON,
        dependsOn: request.on,
        unmet: unmetDependencies(resolved).map(dependencyPayload),
        note: request.note ?? null,
      },
    });
    return {
      ticket: blocked,
      previousStatus: ticket.status,
      dependencies: resolved,
    };
  });
};

export const recordPublished = (
  store: HoldStore,
  request: PublishedRequest,
): Promise<BuilderTicket> =>
  store.db.transaction(async (tx) => {
    const ticket = await lockTicket(tx, store.projectId, request.ticketId);
    if (ticket === undefined)
      throw new TicketNotPublishableError(
        request.ticketId,
        'it is not in this project',
      );
    if (ticket.status !== 'done')
      throw new TicketNotPublishableError(
        request.ticketId,
        `it is ${ticket.status}; only a merged ticket is published`,
      );
    await publishEvent(tx, store.projectId, {
      kind: TICKET_PUBLISHED_EVENT,
      ticketId: ticket.id,
      payload: { package: request.package, version: request.version },
    });
    return ticket;
  });

interface BlockPayload {
  reason?: unknown;
  previousStatus?: unknown;
}

interface HeldRow extends BuilderTicket {
  block: BlockPayload | null;
}

const latestBlock = async (
  db: Queryable,
  projectId: string,
  ticketId: string,
): Promise<BlockPayload | undefined> => {
  const { rows } = await db.query<{ payload: BlockPayload }>(
    `select payload from events
     where project_id = $1 and ticket_id = $2 and kind = $3
     order by id desc limit 1`,
    [projectId, ticketId, TICKET_BLOCKED_EVENT],
  );
  return rows[0]?.payload;
};

const restoredStatus = (previous: unknown): string => {
  if (
    typeof previous === 'string' &&
    BLOCKABLE_TICKET_STATUSES.includes(previous)
  )
    return previous;
  return 'assigned';
};

export const readHeldTickets = async (
  store: HoldStore,
): Promise<HeldTicket[]> => {
  const { rows } = await store.db.query<HeldRow>(
    `select * from (
       select ${TICKET_COLUMNS}, created_at,
         (select e.payload from events e
          where e.project_id = tickets.project_id and e.ticket_id = tickets.id
            and e.kind = $2
          order by e.id desc limit 1) as block
       from tickets where project_id = $1 and status = 'blocked'
     ) held
     where block ->> 'reason' = $3
     order by created_at, id`,
    [store.projectId, TICKET_BLOCKED_EVENT, DEPENDENCIES_REASON],
  );
  return rows.map(({ block, ...ticket }) => ({
    ...ticket,
    previousStatus: restoredStatus(block?.previousStatus),
  }));
};

const lastMark = async (
  db: Queryable,
  projectId: string,
  ticketId: string,
): Promise<string | null> => {
  const { rows } = await db.query<{ kind: string }>(
    `select kind from events
     where project_id = $1 and ticket_id = $2 and kind = any($3::text[])
     order by id desc limit 1`,
    [projectId, ticketId, MARK_EVENTS],
  );
  return rows[0]?.kind ?? null;
};

export const readDependentTickets = async (
  store: HoldStore,
): Promise<DependentTicket[]> => {
  const { rows } = await store.db.query<
    BuilderTicket & { mark: string | null }
  >(
    `select ${TICKET_COLUMNS},
       (select e.kind from events e
        where e.project_id = tickets.project_id and e.ticket_id = tickets.id
          and e.kind = any($2::text[])
        order by e.id desc limit 1) as mark
     from tickets
     where project_id = $1 and status = 'open' and assignee_id is null
       and cardinality(depends_on) > 0
     order by created_at, id`,
    [store.projectId, MARK_EVENTS],
  );
  return rows.map(({ mark, ...ticket }) => ({
    ...ticket,
    waiting: mark === TICKET_WAITING_EVENT,
  }));
};

export interface Unblocked {
  ticket: BuilderTicket;
  held: boolean;
}

export const unblockHeld = (
  store: HoldStore,
  ticketId: string,
  dependencies: readonly Dependency[],
): Promise<Unblocked | undefined> =>
  store.db.transaction(async (tx) => {
    const ticket = await lockTicket(tx, store.projectId, ticketId);
    if (ticket?.status !== 'blocked') return undefined;
    const block = await latestBlock(tx, store.projectId, ticketId);
    if (block?.reason !== DEPENDENCIES_REASON) return undefined;
    const { rows } = await tx.query<BuilderTicket>(
      `update tickets set status = $3
       where id = $1 and project_id = $2 and status = 'blocked'
       returning ${TICKET_COLUMNS}`,
      [ticketId, store.projectId, restoredStatus(block.previousStatus)],
    );
    const [restored] = rows;
    if (restored === undefined) return undefined;
    const event: PublishInput = {
      kind: TICKET_UNBLOCKED_EVENT,
      ticketId,
      payload: {
        held: true,
        status: restored.status,
        dependencies: dependencies.map(dependencyPayload),
      },
    };
    if (restored.assigneeId !== null) event.agentId = restored.assigneeId;
    await publishEvent(tx, store.projectId, event);
    return { ticket: restored, held: true };
  });

const isStillWaiting = (ticket: BuilderTicket | undefined): boolean =>
  ticket?.status === 'open' && ticket.assigneeId === null;

export const markWaiting = (
  store: HoldStore,
  ticketId: string,
  dependencies: readonly Dependency[],
): Promise<boolean> =>
  store.db.transaction(async (tx) => {
    const ticket = await lockTicket(tx, store.projectId, ticketId);
    if (!isStillWaiting(ticket)) return false;
    if (
      (await lastMark(tx, store.projectId, ticketId)) === TICKET_WAITING_EVENT
    )
      return false;
    await publishEvent(tx, store.projectId, {
      kind: TICKET_WAITING_EVENT,
      ticketId,
      payload: {
        dependsOn: ticket?.dependsOn ?? [],
        unmet: unmetDependencies(dependencies).map(dependencyPayload),
      },
    });
    return true;
  });

export const markUnblocked = (
  store: HoldStore,
  ticketId: string,
  dependencies: readonly Dependency[],
): Promise<Unblocked | undefined> =>
  store.db.transaction(async (tx) => {
    const ticket = await lockTicket(tx, store.projectId, ticketId);
    if (ticket === undefined || !isStillWaiting(ticket)) return undefined;
    if (
      (await lastMark(tx, store.projectId, ticketId)) !== TICKET_WAITING_EVENT
    )
      return undefined;
    await publishEvent(tx, store.projectId, {
      kind: TICKET_UNBLOCKED_EVENT,
      ticketId,
      payload: {
        held: false,
        status: ticket.status,
        dependencies: dependencies.map(dependencyPayload),
      },
    });
    return { ticket, held: false };
  });

export const readyLines = (dependencies: readonly Dependency[]): string =>
  dependencies
    .map(
      (dependency) =>
        `- ${dependencyLabel(dependency)}: ${readyText(dependency)}`,
    )
    .join('\n');

export const wakePrompt = (
  ticket: Pick<BuilderTicket, 'id' | 'title'>,
  dependencies: readonly Dependency[],
): string =>
  [
    `Ticket "${ticket.title}" (ticket ${ticket.id}) is no longer blocked. Everything it waited on is ready:`,
    readyLines(dependencies),
    'Bump each published dependency to the version listed, then carry on with the ticket.',
  ].join('\n\n');
