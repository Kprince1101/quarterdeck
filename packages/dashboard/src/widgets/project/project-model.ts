import type {
  AgentRow,
  ProjectRow,
  SnapshotTables,
  TicketRow,
} from '@quarterdeck/server/stream-schema';

export const NO_REVIEWER = 'none';

const FINISHED_STATUSES: ReadonlySet<AgentRow['status']> = new Set([
  'ended',
  'killed',
  'retired',
]);

const REFRESHED_ROLES: ReadonlySet<AgentRow['role']> = new Set([
  'builder',
  'reviewer',
]);

const ACTIVE_TICKET_STATUSES: ReadonlySet<TicketRow['status']> = new Set([
  'assigned',
  'in_progress',
  'in_review',
  'bounced',
  'blocked',
]);

export interface ProjectOption {
  value: string;
  label: string;
}

export interface ProjectPanel {
  id: string;
  slug: string;
  name: string;
  isArchived: boolean;
  reviewer: string;
  retiredCount: number;
  idleAgentIds: string[];
}

export interface ProjectModel {
  options: ProjectOption[];
  chosenId: string;
  panel: ProjectPanel | null;
}

const archivedLast = (a: ProjectRow, b: ProjectRow): number =>
  Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
  a.name.localeCompare(b.name);

const optionLabel = ({ name, archivedAt }: ProjectRow): string => {
  if (archivedAt === null) return name;
  return `${name} (archived)`;
};

const activeTickets = (tickets: readonly TicketRow[]): TicketRow[] =>
  tickets.filter(
    ({ status, assigneeId }) =>
      assigneeId !== null && ACTIVE_TICKET_STATUSES.has(status),
  );

const isLive = ({ status }: AgentRow): boolean =>
  !FINISHED_STATUSES.has(status);

const idleWithoutTicket = (
  agents: readonly AgentRow[],
  active: readonly TicketRow[],
): string[] => {
  const holders = new Set(active.map(({ assigneeId }) => assigneeId));
  return agents
    .filter(
      ({ id, role, status }) =>
        REFRESHED_ROLES.has(role) && status === 'idle' && !holders.has(id),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ id }) => id);
};

const reviewerOf = (agents: readonly AgentRow[]): string => {
  const names = agents
    .filter((agent) => agent.role === 'reviewer' && isLive(agent))
    .map(({ name }) => name)
    .toSorted((a, b) => a.localeCompare(b));
  if (names.length === 0) return NO_REVIEWER;
  return names.join(', ');
};

const projectPanel = (
  project: ProjectRow,
  tables: SnapshotTables,
): ProjectPanel => {
  const agents = tables.agents.filter(
    ({ projectId }) => projectId === project.id,
  );
  const active = activeTickets(
    tables.tickets.filter(({ projectId }) => projectId === project.id),
  );
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    isArchived: project.archivedAt !== null,
    reviewer: reviewerOf(agents),
    retiredCount: agents.filter(({ status }) => status === 'retired').length,
    idleAgentIds: idleWithoutTicket(agents, active),
  };
};

export const buildProject = (
  tables: SnapshotTables,
  chosenId: string,
): ProjectModel => {
  const projects = tables.projects.toSorted(archivedLast);
  const chosen =
    projects.find(({ id }) => id === chosenId) ?? projects.at(0) ?? null;
  const options = projects.map((project) => ({
    value: project.id,
    label: optionLabel(project),
  }));
  if (chosen === null) return { options, chosenId: '', panel: null };
  return {
    options,
    chosenId: chosen.id,
    panel: projectPanel(chosen, tables),
  };
};
