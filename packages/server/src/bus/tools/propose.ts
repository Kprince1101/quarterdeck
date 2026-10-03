import { z } from 'zod';
import {
  MAX_TEXT_LENGTH,
  hasUniqueValues,
  idSchema,
  titleSchema,
} from '../../intents/fields.js';
import { activeProjects, type OpenProject } from '../../planner/projects.js';
import {
  TICKET_SPEC_FORMAT,
  describeProblems,
  proposalProblems,
} from '../../planner/spec.js';
import { publishEvent, type Queryable } from '../../store/index.js';
import { BusToolError, defineBusTool, type BusStore } from '../tool.js';

export const PROPOSED_EVENT = 'ticket.proposed';

export const PROPOSAL_REFUSED_EVENT = 'planner.proposal_refused';

const MAX_DEPENDENCIES = 50;

const MAX_PROJECT_LENGTH = 200;

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

interface Proposal {
  title: string;
  body: string;
  dependsOn: string[];
  project: string;
}

const refuse = async (
  store: BusStore,
  agentId: string,
  proposal: Proposal,
  problems: readonly string[],
): Promise<never> => {
  await store.db.transaction(async (tx) => {
    await assertPlanner(tx, store.projectId, agentId);
    await publishEvent(tx, store.projectId, {
      kind: PROPOSAL_REFUSED_EVENT,
      agentId,
      payload: { title: proposal.title, project: proposal.project, problems },
    });
  });
  throw new BusToolError(
    `Nothing was proposed: ${describeProblems(problems)}. Fix the proposal and propose the ticket again.\n\n${TICKET_SPEC_FORMAT}`,
  );
};

const insertTicket = async (
  tx: Queryable,
  projectId: string,
  proposal: Proposal,
): Promise<string> => {
  await assertDependencies(tx, projectId, proposal.dependsOn);
  const { rows } = await tx.query<{ id: string }>(
    `insert into tickets (project_id, title, body, depends_on, status)
     values ($1, $2, $3, $4::uuid[], 'proposed') returning id`,
    [projectId, proposal.title, proposal.body, proposal.dependsOn],
  );
  const ticketId = rows[0]?.id;
  if (ticketId === undefined)
    throw new BusToolError('the ticket was not stored');
  return ticketId;
};

const recordProposed = (
  tx: Queryable,
  store: BusStore,
  agentId: string,
  proposed: { ticketId: string; title: string; project: string; here: boolean },
) =>
  publishEvent(tx, store.projectId, {
    kind: PROPOSED_EVENT,
    agentId,
    ...(proposed.here && { ticketId: proposed.ticketId }),
    payload: {
      title: proposed.title,
      project: proposed.project,
      ticketId: proposed.ticketId,
    },
  });

const proposeHere = (
  store: BusStore,
  agentId: string,
  proposal: Proposal,
): Promise<string> =>
  store.db.transaction(async (tx) => {
    await assertPlanner(tx, store.projectId, agentId);
    const ticketId = await insertTicket(tx, store.projectId, proposal);
    await recordProposed(tx, store, agentId, {
      ...proposal,
      ticketId,
      here: true,
    });
    return ticketId;
  });

const proposeElsewhere = async (
  store: BusStore,
  agentId: string,
  proposal: Proposal,
  target: BusStore,
): Promise<string> => {
  await assertPlanner(store.db, store.projectId, agentId);
  const ticketId = await target.db.transaction((tx) =>
    insertTicket(tx, target.projectId, proposal),
  );
  try {
    await store.db.transaction(async (tx) => {
      await assertPlanner(tx, store.projectId, agentId);
      await recordProposed(tx, store, agentId, {
        ...proposal,
        ticketId,
        here: false,
      });
    });
  } catch (err) {
    await target.db.query('delete from tickets where id = $1', [ticketId]);
    throw err;
  }
  return ticketId;
};

const targetOf = (
  projects: readonly OpenProject<BusStore>[],
  slug: string,
): BusStore => {
  const target = projects.find((project) => project.slug === slug);
  if (!target) throw new BusToolError(`project ${slug} is not open`);
  return target.store;
};

export default defineBusTool({
  description: [
    'Planner only. Propose one ticket: the project it belongs to, a title, a body written as a spec (## Requirements, ## Design, ## Tasks, then a final `Proven:` line), and the ids of tickets in that project it depends on.',
    'A proposal that names no active project, or whose body does not follow the spec format, is refused and nothing is stored.',
    'The ticket is stored as proposed in its project. The human approves, edits or rejects it; only approved tickets reach the Driver.',
    'Returns the new ticket id, which later proposals in the same project can name in dependsOn.',
  ].join('\n'),
  input: {
    project: z.string().trim().max(MAX_PROJECT_LENGTH).default(''),
    title: titleSchema,
    body: z.string().max(MAX_TEXT_LENGTH).default(''),
    dependsOn: z
      .array(idSchema)
      .max(MAX_DEPENDENCIES)
      .refine(hasUniqueValues, 'dependsOn must not repeat a ticket')
      .default([]),
  },
  run: async ({ store, agentId, openStores }, proposal) => {
    const projects = await activeProjects(openStores?.() ?? [store]);
    const problems = proposalProblems(
      proposal,
      projects.map(({ slug }) => slug),
    );
    if (problems.length > 0) return refuse(store, agentId, proposal, problems);
    const target = targetOf(projects, proposal.project);
    if (target.projectId === store.projectId)
      return `proposed ${await proposeHere(store, agentId, proposal)}`;
    return `proposed ${await proposeElsewhere(store, agentId, proposal, target)}`;
  },
});
