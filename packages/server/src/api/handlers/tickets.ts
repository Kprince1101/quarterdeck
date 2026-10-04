import type { Queryable } from '../../store/index.js';
import type { ApiContext, IntentHandlers } from '../context.js';
import { badRequest, conflict } from '../http-error.js';
import { applyInProject, findRow } from '../record.js';

type TicketIntentName =
  | 'ticket.create'
  | 'ticket.update'
  | 'ticket.cancel'
  | 'ticket.approve'
  | 'ticket.reject';

interface TicketEdits {
  title?: string | undefined;
  body?: string | undefined;
  dependsOn?: string[] | undefined;
}

const CLOSED_STATUSES = new Set(['done', 'cancelled', 'rejected']);
const CANCELLABLE_STATUSES = new Set(['open', 'bounced']);

const FOUND_TICKETS = `select id from tickets
  where project_id = $1 and id = any($2::uuid[])`;

const foundIn = async (
  db: Queryable,
  projectId: string,
  ids: readonly string[],
): Promise<string[]> => {
  const { rows } = await db.query<{ id: string }>(FOUND_TICKETS, [
    projectId,
    ids,
  ]);
  return rows.map((row) => row.id);
};

const assertDependencies = async (
  ctx: ApiContext,
  tx: Queryable,
  projectId: string,
  dependsOn: string[] | undefined,
) => {
  if (dependsOn === undefined || dependsOn.length === 0) return;
  const found = new Set(await foundIn(tx, projectId, dependsOn));
  for (const store of await ctx.stores.opened()) {
    const missing = dependsOn.filter((id) => !found.has(id));
    if (missing.length === 0) break;
    if (store.projectId === projectId) continue;
    for (const id of await foundIn(store.db, store.projectId, missing))
      found.add(id);
  }
  if (dependsOn.some((id) => !found.has(id))) {
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

const requireProposed = async (
  tx: Queryable,
  projectId: string,
  ticketId: string,
) => {
  const status = await ticketStatus(tx, projectId, ticketId);
  if (status !== 'proposed') {
    throw conflict(`ticket ${ticketId} is ${status}, not proposed`);
  }
};

const editTicket = async (
  ctx: ApiContext,
  tx: Queryable,
  projectId: string,
  ticketId: string,
  edits: TicketEdits,
) => {
  if (edits.dependsOn?.includes(ticketId)) {
    throw badRequest('a ticket cannot depend on itself');
  }
  await assertDependencies(ctx, tx, projectId, edits.dependsOn);
  await tx.query(
    `update tickets set
       title = coalesce($2, title),
       body = coalesce($3, body),
       depends_on = coalesce($4::uuid[], depends_on)
     where id = $1`,
    [
      ticketId,
      edits.title ?? null,
      edits.body ?? null,
      edits.dependsOn ?? null,
    ],
  );
};

const assertDependenciesApproved = async (tx: Queryable, ticketId: string) => {
  const { rows } = await tx.query<{ id: string; status: string }>(
    `select d.id, d.status from tickets t
     join tickets d on d.id = any(t.depends_on)
     where t.id = $1 and d.status in ('proposed', 'rejected')
     order by d.created_at`,
    [ticketId],
  );
  if (rows.length === 0) return;
  const blocking = rows.map((row) => `${row.id} (${row.status})`).join(', ');
  throw conflict(
    `ticket ${ticketId} depends on tickets that are not approved: ${blocking}`,
  );
};

export const TICKET_HANDLERS: IntentHandlers<TicketIntentName> = {
  'ticket.create': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      await assertDependencies(ctx, tx, projectId, input.dependsOn);
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
      await editTicket(ctx, tx, projectId, input.ticketId, input);
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
  'ticket.approve': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      await requireProposed(tx, projectId, input.ticketId);
      await editTicket(ctx, tx, projectId, input.ticketId, input);
      await assertDependenciesApproved(tx, input.ticketId);
      await tx.query(`update tickets set status = 'open' where id = $1`, [
        input.ticketId,
      ]);
      return { ticketId: input.ticketId, status: 'open' };
    }),
  'ticket.reject': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      await requireProposed(tx, projectId, input.ticketId);
      await tx.query(`update tickets set status = 'rejected' where id = $1`, [
        input.ticketId,
      ]);
      return { ticketId: input.ticketId, status: 'rejected' };
    }),
};
