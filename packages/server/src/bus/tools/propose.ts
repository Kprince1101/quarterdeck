import { z } from 'zod';
import {
  MAX_TEXT_LENGTH,
  externalRefSchema,
  hasUniqueValues,
  idSchema,
  titleSchema,
} from '../../intents/fields.js';
import { dropUndecided } from '../../planner/move.js';
import { activeProjects, type OpenProject } from '../../planner/projects.js';
import {
  TICKET_SPEC_FORMAT,
  describeProblems,
  proposalProblems,
} from '../../planner/spec.js';
import { publishEvent, type Queryable } from '../../store/index.js';
import type { WorkspaceMode } from '../../stream/schema.js';
import { multiOnly, singleOnly } from '../../workspace/wording.js';
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

interface DependencyRow {
  id: string;
  status: string;
}

const DEPENDENCY_ROWS = `select id, status from tickets
  where project_id = $1 and id = any($2::uuid[])`;

const findDependencies = async (
  tx: Queryable,
  projectId: string,
  dependsOn: readonly string[],
  others: readonly BusStore[],
): Promise<DependencyRow[]> => {
  const { rows } = await tx.query<DependencyRow>(DEPENDENCY_ROWS, [
    projectId,
    dependsOn,
  ]);
  for (const other of others) {
    if (other.projectId === projectId) continue;
    const missing = dependsOn.filter(
      (id) => !rows.some((row) => row.id === id),
    );
    if (missing.length === 0) break;
    const found = await other.db.query<DependencyRow>(DEPENDENCY_ROWS, [
      other.projectId,
      missing,
    ]);
    rows.push(...found.rows);
  }
  return rows;
};

const assertDependencies = async (
  tx: Queryable,
  projectId: string,
  dependsOn: readonly string[],
  others: readonly BusStore[],
) => {
  if (dependsOn.length === 0) return;
  const rows = await findDependencies(tx, projectId, dependsOn, others);
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
  externalRef?: string | undefined;
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
  others: readonly BusStore[],
): Promise<string> => {
  await assertDependencies(tx, projectId, proposal.dependsOn, others);
  const { rows } = await tx.query<{ id: string }>(
    `insert into tickets
       (project_id, title, body, depends_on, external_ref, status)
     values ($1, $2, $3, $4::uuid[], $5, 'proposed') returning id`,
    [
      projectId,
      proposal.title,
      proposal.body,
      proposal.dependsOn,
      proposal.externalRef ?? null,
    ],
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
  others: readonly BusStore[],
): Promise<string> =>
  store.db.transaction(async (tx) => {
    await assertPlanner(tx, store.projectId, agentId);
    const ticketId = await insertTicket(tx, store.projectId, proposal, others);
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
  others: readonly BusStore[],
): Promise<string> => {
  await assertPlanner(store.db, store.projectId, agentId);
  const ticketId = await target.db.transaction((tx) =>
    insertTicket(tx, target.projectId, proposal, others),
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
    await dropUndecided(target, ticketId);
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

const impliedProject = (
  mode: WorkspaceMode | undefined,
  proposal: Proposal,
  projects: readonly OpenProject<BusStore>[],
): Proposal => {
  const [only, ...others] = projects;
  if (mode !== 'single' || proposal.project !== '') return proposal;
  if (only === undefined || others.length > 0) return proposal;
  return { ...proposal, project: only.slug };
};

export default defineBusTool({
  description: [
    multiOnly(
      'Planner only. Propose one ticket: the project it belongs to, a title, a body written as a spec (## Requirements, ## Design, ## Tasks, then a final `Proven:` line), and the ids of tickets it depends on, in any open project.',
    ),
    singleOnly(
      'Planner only. Propose one ticket: a title, a body written as a spec (## Requirements, ## Design, ## Tasks, then a final `Proven:` line), and the ids of tickets it depends on.',
    ),
    multiOnly(
      'A proposal that names no active project, or whose body does not follow the spec format, is refused and nothing is stored.',
    ),
    singleOnly(
      'A proposal whose body does not follow the spec format is refused and nothing is stored.',
    ),
    multiOnly(
      'The ticket is stored as proposed in its project. The human approves, edits or rejects it; only approved tickets reach the Driver.',
    ),
    singleOnly(
      'The ticket is stored as proposed. The human approves, edits or rejects it; only approved tickets reach the Driver.',
    ),
    multiOnly(
      'Returns the new ticket id, which later proposals in any project can name in dependsOn.',
    ),
    singleOnly(
      'Returns the new ticket id, which later proposals can name in dependsOn.',
    ),
    "When the work comes from the project's tracker, pass its id there (a Jira key, a story number) as externalRef; agents see it in their prompts.",
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
    externalRef: externalRefSchema.optional(),
  },
  run: async ({ store, agentId, openStores, mode }, input) => {
    const stores = [store, ...(openStores?.() ?? [])];
    const projects = await activeProjects(stores);
    const proposal = impliedProject(mode, input, projects);
    const problems = proposalProblems(
      proposal,
      projects.map(({ slug }) => slug),
    );
    if (problems.length > 0) return refuse(store, agentId, proposal, problems);
    const target = targetOf(projects, proposal.project);
    if (target.projectId === store.projectId)
      return `proposed ${await proposeHere(store, agentId, proposal, stores)}`;
    return `proposed ${await proposeElsewhere(store, agentId, proposal, target, stores)}`;
  },
});
