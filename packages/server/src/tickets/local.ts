import { APPROVED_TICKET_STATUS } from '../driver/tickets.js';
import { publishEvent, type Queryable, type Store } from '../store/index.js';
import { TicketNotFoundError } from './errors.js';
import {
  checkedSource,
  type ApprovedTicket,
  type TicketSource,
} from './source.js';

export const LOCAL_TICKET_SOURCE = 'local';

export const TICKET_NOTED_EVENT = 'ticket.noted';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const updateTicket = async (
  db: Queryable,
  projectId: string,
  ref: string,
  set: string,
  params: unknown[],
): Promise<void> => {
  if (!UUID.test(ref)) throw new TicketNotFoundError(ref);
  const { rows } = await db.query(
    `update tickets set ${set} where id = $1 and project_id = $2 returning id`,
    [ref, projectId, ...params],
  );
  if (rows.length === 0) throw new TicketNotFoundError(ref);
};

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
      updateTicket(store.db, store.projectId, ref, 'status = $3', [status]),
    note: (ref, body) =>
      store.db.transaction(async (tx) => {
        await updateTicket(tx, store.projectId, ref, 'updated_at = now()', []);
        await publishEvent(tx, store.projectId, {
          kind: TICKET_NOTED_EVENT,
          ticketId: ref,
          payload: { body },
        });
      }),
    attachPr: (ref, pr) =>
      updateTicket(
        store.db,
        store.projectId,
        ref,
        'pr_url = $3, head_sha = $4',
        [pr.url, pr.head],
      ),
  });
