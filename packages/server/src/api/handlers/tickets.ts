import type { Queryable } from '../../store/index.js';
import type { IntentHandlers } from '../context.js';
import { badRequest, conflict } from '../http-error.js';
import { applyInProject, findRow } from '../record.js';

type TicketIntentName = 'ticket.create' | 'ticket.update' | 'ticket.cancel';

const CLOSED_STATUSES = new Set(['done', 'cancelled']);
const CANCELLABLE_STATUSES = new Set(['open', 'bounced']);

const assertDependencies = async (
  tx: Queryable,
  projectId: string,
  dependsOn: string[] | undefined,
) => {
  if (dependsOn === undefined || dependsOn.length === 0) return;
  const { rows } = await tx.query<{ found: number }>(
    `select count(*)::int as found from tickets
     where project_id = $1 and id = any($2::uuid[])`,
    [projectId, dependsOn],
  );
  if (rows[0]?.found !== dependsOn.length) {
    throw badRequest('dependsOn names a ticket that does not exist');
  }
};

const ticketStatus = async (
  tx: Queryable,
  projectId: string,
  ticketId: string,
): Promise<string> => {
  const ticket = await findRow<{ status: string }>(
    tx,
    `select status from tickets
     where id = $1 and project_id = $2 for update`,
    [ticketId, projectId],
    `ticket ${ticketId} not found`,
  );
  return ticket.status;
};

export const TICKET_HANDLERS: IntentHandlers<TicketIntentName> = {
  'ticket.create': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      await assertDependencies(tx, projectId, input.dependsOn);
      const ticket = await findRow<{ id: string }>(
        tx,
        `insert into tickets (project_id, title, body, depends_on)
         values ($1, $2, $3, $4::uuid[]) returning id`,
        [projectId, input.title, input.body, input.dependsOn],
        'ticket was not created',
      );
      return { ticketId: ticket.id };
    }),
  'ticket.update': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      const status = await ticketStatus(tx, projectId, input.ticketId);
      if (CLOSED_STATUSES.has(status)) {
        throw conflict(`ticket ${input.ticketId} is ${status}`);
      }
      if (input.dependsOn?.includes(input.ticketId)) {
        throw badRequest('a ticket cannot depend on itself');
      }
      await assertDependencies(tx, projectId, input.dependsOn);
      await tx.query(
        `update tickets set
           title = coalesce($2, title),
           body = coalesce($3, body),
           depends_on = coalesce($4::uuid[], depends_on)
         where id = $1`,
        [
          input.ticketId,
          input.title ?? null,
          input.body ?? null,
          input.dependsOn ?? null,
        ],
      );
      return { ticketId: input.ticketId };
    }),
  'ticket.cancel': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      const status = await ticketStatus(tx, projectId, input.ticketId);
      if (!CANCELLABLE_STATUSES.has(status)) {
        throw conflict(
          `ticket ${input.ticketId} is ${status}; only open or bounced tickets can be cancelled`,
        );
      }
      await tx.query(`update tickets set status = 'cancelled' where id = $1`, [
        input.ticketId,
      ]);
      return { ticketId: input.ticketId, status: 'cancelled' };
    }),
};
