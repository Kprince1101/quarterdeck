import { z } from 'zod';
import {
  MAX_TEXT_LENGTH,
  hasUniqueValues,
  idSchema,
  titleSchema,
} from '../../intents/fields.js';
import { publishEvent, type Queryable } from '../../store/index.js';
import { BusToolError, defineBusTool } from '../tool.js';

export const PROPOSED_EVENT = 'ticket.proposed';

const MAX_DEPENDENCIES = 50;

const UNUSABLE_DEPENDENCY_STATUSES = ['rejected', 'cancelled'];

const FINISHED_STATUSES = ['ended', 'killed', 'retired'];

const assertPlanner = async (
  tx: Queryable,
  projectId: string,
  agentId: string,
) => {
  const { rows } = await tx.query<{ role: string; status: string }>(
    'select role, status from agents where id = $1 and project_id = $2',
    [agentId, projectId],
  );
  const [agent] = rows;
  if (agent?.role !== 'planner')
    throw new BusToolError('only the Planner can propose tickets');
  if (FINISHED_STATUSES.includes(agent.status))
    throw new BusToolError('this conversation has ended');
};

const assertDependencies = async (
  tx: Queryable,
  projectId: string,
  dependsOn: readonly string[],
) => {
  if (dependsOn.length === 0) return;
  const { rows } = await tx.query<{ id: string; status: string }>(
    `select id, status from tickets
     where project_id = $1 and id = any($2::uuid[])`,
    [projectId, dependsOn],
  );
  const missing = dependsOn.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length > 0)
    throw new BusToolError(
      `dependsOn names tickets that do not exist: ${missing.join(', ')}`,
    );
  const unusable = rows.filter((row) =>
    UNUSABLE_DEPENDENCY_STATUSES.includes(row.status),
  );
  if (unusable.length > 0)
    throw new BusToolError(
      `dependsOn names tickets that will never be built: ${unusable
        .map((row) => `${row.id} (${row.status})`)
        .join(', ')}`,
    );
};

export default defineBusTool({
  description: [
    'Planner only. Propose one ticket: a title, a body saying what to build and how it is tested, and the ids of tickets it depends on.',
    'The ticket is stored as proposed. The human approves, edits or rejects it; only approved tickets reach the Driver.',
    'Returns the new ticket id, which later proposals can name in dependsOn.',
  ].join('\n'),
  input: {
    title: titleSchema,
    body: z.string().max(MAX_TEXT_LENGTH).default(''),
    dependsOn: z
      .array(idSchema)
      .max(MAX_DEPENDENCIES)
      .refine(hasUniqueValues, 'dependsOn must not repeat a ticket')
      .default([]),
  },
  run: ({ store, agentId }, { title, body, dependsOn }) =>
    store.db.transaction(async (tx) => {
      await assertPlanner(tx, store.projectId, agentId);
      await assertDependencies(tx, store.projectId, dependsOn);
      const { rows } = await tx.query<{ id: string }>(
        `insert into tickets (project_id, title, body, depends_on, status)
         values ($1, $2, $3, $4::uuid[], 'proposed') returning id`,
        [store.projectId, title, body, dependsOn],
      );
      const ticketId = rows[0]?.id;
      if (ticketId === undefined)
        throw new BusToolError('the ticket was not stored');
      await publishEvent(tx, store.projectId, {
        kind: PROPOSED_EVENT,
        agentId,
        ticketId,
        payload: { title },
      });
      return `proposed ${ticketId}`;
    }),
});
