import type {
  AgentRow,
  ProjectRow,
  RoundRow,
  SnapshotTables,
} from '@quarterdeck/server/stream-schema';

export const NO_REVIEWER = 'none';

export const NOT_WIRED = 'not wired yet';

const FINISHED_STATUSES: ReadonlySet<AgentRow['status']> = new Set([
  'ended',
  'killed',
  'retired',
]);

const REFRESHED_ROLES: ReadonlySet<AgentRow['role']> = new Set([
  'builder',
  'reviewer',
]);

export interface ProjectOption {
  value: string;
  label: string;
}

export interface RoundView {
  id: string;
  label: string;
  goal: string;
}

export interface ProjectPanel {
  id: string;
  slug: string;
  name: string;
  isArchived: boolean;
  round: RoundView | null;
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

const openRound = (
  rounds: readonly RoundRow[],
  projectId: string,
): RoundView | null => {
  const [round] = rounds
    .filter((row) => row.projectId === projectId && row.status !== 'ended')
    .toSorted((a, b) => b.number - a.number);
  if (round === undefined) return null;
  return {
    id: round.id,
    label: `Round ${round.number} · ${round.status}`,
    goal: round.goal,
  };
};

const isLive = ({ status }: AgentRow): boolean =>
  !FINISHED_STATUSES.has(status);

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
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    isArchived: project.archivedAt !== null,
    round: openRound(tables.rounds, project.id),
    reviewer: reviewerOf(agents),
    retiredCount: agents.filter(({ status }) => status === 'retired').length,
    idleAgentIds: agents
      .filter(
        ({ role, status }) => REFRESHED_ROLES.has(role) && status === 'idle',
      )
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id }) => id),
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
