import type { PGlite } from '@electric-sql/pglite';

export const EVENTS_CHANNEL = 'quarterdeck_events';

export const EVENT_BATCH = 100;

export interface StoreEvent {
  id: number;
  projectId: string;
  agentId: string | null;
  ticketId: string | null;
  kind: string;
  payload: unknown;
  createdAt: Date;
}

export interface PublishInput {
  kind: string;
  payload?: unknown;
  agentId?: string;
  ticketId?: string;
}

export type EventHandler = (event: StoreEvent) => void | Promise<void>;

export interface SubscribeOptions {
  after?: number;
  onError?: (err: unknown) => void;
}

export interface Subscription {
  readonly cursor: number;
  close: () => Promise<void>;
}

const EVENT_COLUMNS = `id, project_id as "projectId", agent_id as "agentId",
  ticket_id as "ticketId", kind, payload, created_at as "createdAt"`;

const reportError = (err: unknown): void => {
  console.error('quarterdeck event subscriber failed', err);
};

export const publishEvent = async (
  db: PGlite,
  projectId: string,
  input: PublishInput,
): Promise<StoreEvent> => {
  const { rows } = await db.query<StoreEvent>(
    `insert into events (project_id, agent_id, ticket_id, kind, payload)
     values ($1, $2, $3, $4, $5::jsonb)
     returning ${EVENT_COLUMNS}`,
    [
      projectId,
      input.agentId ?? null,
      input.ticketId ?? null,
      input.kind,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  const [event] = rows;
  if (!event) throw new Error(`Could not publish event ${input.kind}`);
  return event;
};

const latestEventId = async (
  db: PGlite,
  projectId: string,
): Promise<number> => {
  const { rows } = await db.query<{ id: number }>(
    'select coalesce(max(id), 0)::int8 as id from events where project_id = $1',
    [projectId],
  );
  return Number(rows[0]?.id ?? 0);
};

const eventsAfter = async (
  db: PGlite,
  projectId: string,
  cursor: number,
): Promise<StoreEvent[]> => {
  const { rows } = await db.query<StoreEvent>(
    `select ${EVENT_COLUMNS} from events
     where project_id = $1 and id > $2
     order by id
     limit ${EVENT_BATCH}`,
    [projectId, cursor],
  );
  return rows;
};

export const subscribeEvents = async (
  db: PGlite,
  projectId: string,
  handler: EventHandler,
  options: SubscribeOptions = {},
): Promise<Subscription> => {
  const onError = options.onError ?? reportError;
  const report = (err: unknown): void => {
    try {
      onError(err);
    } catch (failure) {
      reportError(failure);
    }
  };
  let cursor = options.after ?? (await latestEventId(db, projectId));
  let closed = false;
  let queued = false;

  const deliver = async (events: StoreEvent[]): Promise<void> => {
    for (const event of events) {
      if (closed) return;
      cursor = event.id;
      try {
        await handler(event);
      } catch (err) {
        report(err);
      }
    }
  };

  const drain = async (): Promise<void> => {
    queued = false;
    if (closed) return;
    const events = await eventsAfter(db, projectId, cursor);
    await deliver(events);
    if (events.length === EVENT_BATCH && !closed) await drain();
  };

  let tail: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    if (queued || closed) return;
    queued = true;
    tail = tail.then(drain).catch(report);
  };

  const unlisten = await db.listen(EVENTS_CHANNEL, schedule);
  schedule();

  const shutdown = async (): Promise<void> => {
    closed = true;
    await unlisten();
    await tail;
  };
  let closing: Promise<void> | undefined;

  return {
    get cursor() {
      return cursor;
    },
    close: () => {
      closing ??= shutdown();
      return closing;
    },
  };
};
