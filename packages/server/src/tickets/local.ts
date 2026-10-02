import { APPROVED_TICKET_STATUS } from '../driver/tickets.js';
import {
  publishEvent,
  type PublishInput,
  type Queryable,
  type Store,
} from '../store/index.js';
import { TicketNotFoundError } from './errors.js';
import {
  checkedSource,
  type ApprovedTicket,
  type TicketSource,
} from './source.js';

export const LOCAL_TICKET_SOURCE = 'local';

export const TICKET_NOTED_EVENT = 'ticket.noted';
export const TICKET_STATUS_SET_EVENT = 'ticket.status_set';
export const TICKET_PR_ATTACHED_EVENT = 'ticket.pr_attached';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lockTicket = async (
  tx: Queryable,
  projectId: string,
  ref: string,
): Promise<{ status: string }> => {
  if (!UUID.test(ref)) throw new TicketNotFoundError(ref);
  const {
    rows: [ticket],
  } = await tx.query<{ status: string }>(
    `select status from tickets where id = $1 and project_id = $2 for update`,
    [ref, projectId],
  );
  if (ticket === undefined) throw new TicketNotFoundError(ref);
  return ticket;
};

const recordChange = (
  store: Store,
  ref: string,
  change: (tx: Queryable) => Promise<unknown>,
  event: (before: { status: string }) => Omit<PublishInput, 'ticketId'>,
): Promise<void> =>
  store.db.transaction(async (tx) => {
    const before = await lockTicket(tx, store.projectId, ref);
    await change(tx);
    await publishEvent(tx, store.projectId, {
      ...event(before),
      ticketId: ref,
    });
  });

export const localTicketSource = (store: Store): TicketSource =>
  checkedSource({
    name: LOCAL_TICKET_SOURCE,
    listApproved: async () => {
      const { rows } = await store.db.query<ApprovedTicket>(
        `select id as ref, title, body from tickets
         where project_id = $1 and status = $2
         order by created_at, id`,
        [store.projectId, APPROVED_TICKET_STATUS],
      );
      return rows;
    },
    setStatus: (ref, status) =>
      recordChange(
        store,
        ref,
        (tx) =>
          tx.query(
            `update tickets set status = $2, updated_at = now() where id = $1`,
            [ref, status],
          ),
        (before) => ({
          kind: TICKET_STATUS_SET_EVENT,
          payload: { status, from: before.status },
        }),
      ),
    note: (ref, body) =>
      recordChange(
        store,
        ref,
        (tx) =>
          tx.query(`update tickets set updated_at = now() where id = $1`, [
            ref,
          ]),
        () => ({ kind: TICKET_NOTED_EVENT, payload: { body } }),
      ),
    attachPr: (ref, pr) =>
      recordChange(
        store,
        ref,
        (tx) =>
          tx.query(
            `update tickets set pr_url = $2, head_sha = $3, updated_at = now()
             where id = $1`,
            [ref, pr.url, pr.head],
          ),
        () => ({
          kind: TICKET_PR_ATTACHED_EVENT,
          payload: { url: pr.url, head: pr.head },
        }),
      ),
  });
