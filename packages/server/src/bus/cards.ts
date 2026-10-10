import {
  CHANGES_CHANNEL,
  publishEvent,
  type PublishInput,
  type Queryable,
} from '../store/index.js';
import { BusToolError, type BusStore } from './tool.js';

export const ASK_CARD = 'ask';
export const ASK_EXPIRY_MS = 60 * 60 * 1000;
export const ASK_EXPIRY_MAX_MS = 2 ** 31 - 1;
export const ASK_PROGRESS_MS = 30_000;

const ACTIVE_TICKET = ['assigned', 'in_progress', 'in_review', 'bounced'];

export type CardOutcomeStatus = 'answered' | 'declined' | 'expired';

export interface CardOutcome {
  cardId: string;
  status: CardOutcomeStatus;
  answer: string | null;
}

export interface AskCard {
  question: string;
  options: string[];
  checked: string;
  recommendation: string;
}

export interface CardInput extends AskCard {
  kind: string;
  signIn?: Record<string, unknown>;
}

export interface CardNotice {
  kind: string;
  payload: Record<string, unknown>;
}

export interface RaisedCard {
  cardId: string;
  ticketId: string | null;
  expiresAt: Date;
}

export interface AwaitCardOptions {
  expiryMs: number;
  signal: AbortSignal;
  onWaiting?: () => Promise<void>;
  progressMs?: number;
}

export const assertAskExpiry = (ms: number): number => {
  if (!Number.isInteger(ms) || ms < 1 || ms > ASK_EXPIRY_MAX_MS)
    throw new RangeError(
      `askExpiryMs must be an integer from 1 to ${ASK_EXPIRY_MAX_MS}; got ${ms}`,
    );
  return ms;
};

export interface CardLinks {
  agent_id: string | null;
  ticket_id: string | null;
}

const cardEvent = (
  kind: string,
  cardId: string,
  links: CardLinks,
  payload: Record<string, unknown> = {},
): PublishInput => {
  const input: PublishInput = { kind, payload: { ...payload, cardId } };
  if (links.agent_id !== null) input.agentId = links.agent_id;
  if (links.ticket_id !== null) input.ticketId = links.ticket_id;
  return input;
};

export const activeTicketId = async (
  tx: Queryable,
  projectId: string,
  agentId: string,
): Promise<string | null> => {
  const { rows } = await tx.query<{ id: string }>(
    `select id from tickets
     where project_id = $1 and assignee_id = $2 and status = any($3::text[])
     order by updated_at desc limit 1`,
    [projectId, agentId, ACTIVE_TICKET],
  );
  return rows[0]?.id ?? null;
};

export const publishCardNotices = async (
  tx: Queryable,
  projectId: string,
  cardId: string,
  links: CardLinks,
  notices: readonly CardNotice[],
): Promise<void> => {
  for (const notice of notices) {
    await publishEvent(
      tx,
      projectId,
      cardEvent(notice.kind, cardId, links, notice.payload),
    );
  }
};

export const insertCard = async (
  tx: Queryable,
  projectId: string,
  agentId: string,
  card: CardInput,
  expiryMs: number,
  notices: readonly CardNotice[] = [],
): Promise<RaisedCard> => {
  const ticketId = await activeTicketId(tx, projectId, agentId);
  const { rows } = await tx.query<{ id: string; expires_at: Date }>(
    `insert into cards (project_id, agent_id, ticket_id, kind, question,
       options, checked, recommendation, sign_in, expires_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $10::jsonb,
       now() + make_interval(secs => $9::float8 / 1000))
     returning id, expires_at`,
    [
      projectId,
      agentId,
      ticketId,
      card.kind,
      card.question,
      JSON.stringify(card.options),
      card.checked,
      card.recommendation,
      expiryMs,
      JSON.stringify(card.signIn ?? null),
    ],
  );
  const [row] = rows;
  if (!row) throw new Error(`Could not raise the ${card.kind} card`);
  const links = { agent_id: agentId, ticket_id: ticketId };
  await publishCardNotices(tx, projectId, row.id, links, [
    { kind: 'card.asked', payload: {} },
    ...notices,
  ]);
  return { cardId: row.id, ticketId, expiresAt: row.expires_at };
};

export const raiseCard = (
  store: BusStore,
  agentId: string,
  card: CardInput,
  expiryMs: number,
  notices: readonly CardNotice[] = [],
): Promise<RaisedCard> =>
  store.db.transaction((tx) =>
    insertCard(tx, store.projectId, agentId, card, expiryMs, notices),
  );

export const raiseAskCard = (
  store: BusStore,
  agentId: string,
  card: AskCard,
  expiryMs: number,
): Promise<RaisedCard> =>
  raiseCard(store, agentId, { ...card, kind: ASK_CARD }, expiryMs);

const readOutcome = async (
  store: BusStore,
  cardId: string,
): Promise<CardOutcome | undefined> => {
  const { rows } = await store.db.query<{
    status: CardOutcomeStatus | 'open';
    answer: string | null;
  }>('select status, answer from cards where id = $1 and project_id = $2', [
    cardId,
    store.projectId,
  ]);
  const [row] = rows;
  if (!row) throw new BusToolError(`card ${cardId} no longer exists`);
  if (row.status === 'open') return undefined;
  return { cardId, status: row.status, answer: row.answer };
};

export const expireCard = async (
  store: BusStore,
  cardId: string,
): Promise<CardOutcome> => {
  await store.db.transaction(async (tx) => {
    const { rows } = await tx.query<CardLinks>(
      `update cards set status = 'expired'
       where id = $1 and project_id = $2 and status = 'open'
       returning agent_id, ticket_id`,
      [cardId, store.projectId],
    );
    const [row] = rows;
    if (!row) return;
    await publishEvent(
      tx,
      store.projectId,
      cardEvent('card.expired', cardId, row),
    );
  });
  const outcome = await readOutcome(store, cardId);
  if (!outcome) throw new Error(`card ${cardId} is still open after expiring`);
  return outcome;
};

export const expireOverdueCards = (
  store: Pick<BusStore, 'db' | 'projectId'>,
  reason: string,
): Promise<string[]> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<CardLinks & { id: string }>(
      `with expired as (
         update cards set status = 'expired'
         where project_id = $1 and status = 'open' and expires_at <= now()
         returning id, agent_id, ticket_id, created_at
       )
       select id, agent_id, ticket_id from expired order by created_at, id`,
      [store.projectId],
    );
    for (const card of rows) {
      await publishEvent(
        tx,
        store.projectId,
        cardEvent('card.expired', card.id, card, { reason }),
      );
    }
    return rows.map((card) => card.id);
  });

const isCardNotice = (payload: string, cardId: string): boolean => {
  try {
    const notice = JSON.parse(payload) as { table?: unknown; id?: unknown };
    return notice.table === 'cards' && notice.id === cardId;
  } catch {
    return false;
  }
};

const ignore = (): void => undefined;

export const awaitCard = async (
  store: BusStore,
  cardId: string,
  options: AwaitCardOptions,
): Promise<CardOutcome> => {
  const { expiryMs, signal, onWaiting } = options;
  let resolve: (outcome: CardOutcome) => void = ignore;
  let reject: (err: unknown) => void = ignore;
  const settled = new Promise<CardOutcome>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const check = (): void => {
    readOutcome(store, cardId).then((outcome) => {
      if (outcome) resolve(outcome);
    }, reject);
  };
  const onAbort = (): void =>
    reject(
      new BusToolError(
        `stopped waiting on card ${cardId}: the call was cancelled; the card stays open`,
      ),
    );

  const unlisten = await store.db.listen(CHANGES_CHANNEL, (payload) => {
    if (isCardNotice(payload, cardId)) check();
  });
  const expiry = setTimeout(() => {
    expireCard(store, cardId).then(resolve, reject);
  }, expiryMs);
  const ticker = setInterval(() => {
    onWaiting?.().catch(ignore);
  }, options.progressMs ?? ASK_PROGRESS_MS);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  check();
  try {
    return await settled;
  } finally {
    clearTimeout(expiry);
    clearInterval(ticker);
    signal.removeEventListener('abort', onAbort);
    await unlisten().catch(ignore);
  }
};
