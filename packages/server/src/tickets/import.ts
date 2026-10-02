import { APPROVED_TICKET_STATUS } from '../driver/tickets.js';
import { publishEvent, type Store } from '../store/index.js';
import { TicketSourceInputError } from './errors.js';
import { LOCAL_TICKET_SOURCE } from './local.js';
import type { TicketSource } from './source.js';

export const TICKETS_IMPORTED_EVENT = 'tickets.imported';

export interface TicketImport {
  source: string;
  created: string[];
  updated: string[];
}

export const importApprovedTickets = async (
  store: Store,
  source: TicketSource,
): Promise<TicketImport> => {
  if (source.name === LOCAL_TICKET_SOURCE)
    throw new TicketSourceInputError(
      source.name,
      'import',
      'the tickets table cannot import from itself',
    );
  const tickets = await source.listApproved();
  return store.db.transaction(async (tx) => {
    const created: string[] = [];
    const updated: string[] = [];
    for (const ticket of tickets) {
      const { rows } = await tx.query<{ id: string; created: boolean }>(
        `insert into tickets (project_id, title, body, status, source, external_id)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (project_id, source, external_id) do update
           set title = excluded.title, body = excluded.body
           where tickets.status = $4
             and (tickets.title, tickets.body)
                 is distinct from (excluded.title, excluded.body)
         returning id, xmax = 0 as created`,
        [
          store.projectId,
          ticket.title,
          ticket.body,
          APPROVED_TICKET_STATUS,
          source.name,
          ticket.ref,
        ],
      );
      const [row] = rows;
      if (row?.created === true) created.push(row.id);
      else if (row !== undefined) updated.push(row.id);
    }
    if (created.length > 0 || updated.length > 0)
      await publishEvent(tx, store.projectId, {
        kind: TICKETS_IMPORTED_EVENT,
        payload: { source: source.name, created, updated },
      });
    return { source: source.name, created, updated };
  });
};
