import type { Forge, ForgeTerms } from '@quarterdeck/rules';
import { publishEvent, type Queryable, type Store } from '../store/index.js';
import {
  GATE_EVENTS,
  HOLD_ANSWER,
  MERGE_ANSWER,
  MERGE_CARD,
  readTicket,
  type GateTicket,
} from './facts.js';

export type GateStore = Pick<Store, 'db' | 'projectId'>;

export interface Guard {
  ticketId: string;
  reportId: number;
}

export type MergedBy = 'gate' | Forge;

export interface PullRequestAt {
  pr: string;
  head: string | null;
}

const latestReportId = async (
  tx: Queryable,
  projectId: string,
  ticketId: string,
): Promise<number> => {
  const { rows } = await tx.query<{ id: number }>(
    `select coalesce(max(id), 0) as id from events
     where project_id = $1 and ticket_id = $2 and kind = $3`,
    [projectId, ticketId, GATE_EVENTS.reported],
  );
  return Number(rows[0]?.id ?? 0);
};

const guarded = (
  store: GateStore,
  guard: Guard,
  apply: (tx: Queryable, ticket: GateTicket) => Promise<void>,
): Promise<boolean> =>
  store.db.transaction(async (tx) => {
    const ticket = await readTicket(tx, store.projectId, guard.ticketId, true);
    if (ticket?.status !== 'in_review') return false;
    const reportId = await latestReportId(tx, store.projectId, guard.ticketId);
    if (reportId !== guard.reportId) return false;
    await apply(tx, ticket);
    return true;
  });

export const recordReviewRequested = (
  store: GateStore,
  guard: Guard,
  reviewerId: string,
  at: PullRequestAt,
): Promise<boolean> =>
  guarded(store, guard, async (tx) => {
    await publishEvent(tx, store.projectId, {
      kind: GATE_EVENTS.reviewRequested,
      ticketId: guard.ticketId,
      agentId: reviewerId,
      payload: { reviewerId, ...at },
    });
  });

export const recordWaiting = (
  store: GateStore,
  guard: Guard,
  reason: string,
  at: PullRequestAt,
): Promise<boolean> =>
  guarded(store, guard, async (tx) => {
    await publishEvent(tx, store.projectId, {
      kind: GATE_EVENTS.waiting,
      ticketId: guard.ticketId,
      payload: { reason, ...at },
    });
  });

export const bounce = (
  store: GateStore,
  guard: Guard,
  reason: string,
  at: PullRequestAt,
): Promise<boolean> =>
  guarded(store, guard, async (tx) => {
    await tx.query(`update tickets set status = 'bounced' where id = $1`, [
      guard.ticketId,
    ]);
    await publishEvent(tx, store.projectId, {
      kind: GATE_EVENTS.bounced,
      ticketId: guard.ticketId,
      payload: { reason, ...at },
    });
  });

export const mergeQuestion = (
  ticket: Pick<GateTicket, 'title'>,
  at: PullRequestAt,
  terms: ForgeTerms,
  error: string | undefined,
): string => {
  const lines = [
    `Merge ${at.pr} for ticket "${ticket.title}" at ${at.head ?? 'its head'}?`,
  ];
  if (error !== undefined)
    lines.push(
      `The gate tried to squash merge the ${terms.short} and failed: ${error}`,
    );
  lines.push(
    `${MERGE_ANSWER} squash merges the ${terms.short}; ${HOLD_ANSWER} leaves it in review for you to merge on ${terms.name}.`,
  );
  return lines.join('\n');
};

export const raiseMergeCard = (
  store: GateStore,
  guard: Guard,
  at: PullRequestAt,
  terms: ForgeTerms,
  error?: string,
): Promise<boolean> =>
  guarded(store, guard, async (tx, ticket) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into cards (project_id, ticket_id, kind, question, options)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [
        store.projectId,
        guard.ticketId,
        MERGE_CARD,
        mergeQuestion(ticket, at, terms, error),
        JSON.stringify([MERGE_ANSWER, HOLD_ANSWER]),
      ],
    );
    const [card] = rows;
    if (!card) throw new Error(`Could not raise a merge card for ${at.pr}`);
    await publishEvent(tx, store.projectId, {
      kind: GATE_EVENTS.mergeRequested,
      ticketId: guard.ticketId,
      payload: { cardId: card.id, ...at, error: error ?? null },
    });
  });

export const markMerged = (
  store: GateStore,
  ticketId: string,
  at: PullRequestAt,
  by: MergedBy,
): Promise<boolean> =>
  store.db.transaction(async (tx) => {
    const ticket = await readTicket(tx, store.projectId, ticketId, true);
    if (ticket === undefined || ticket.status === 'done') return false;
    await tx.query(`update tickets set status = 'done' where id = $1`, [
      ticketId,
    ]);
    await publishEvent(tx, store.projectId, {
      kind: GATE_EVENTS.merged,
      ticketId,
      payload: { ...at, by },
    });
    return true;
  });
