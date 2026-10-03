import type { AgentRow, ProjectRow } from '@quarterdeck/server/stream-schema';
import { z } from 'zod';
import { getErrorMessage } from '../../lib/errors.js';

export const BOARD_PROJECT_CAP = 4;

type AgentRole = AgentRow['role'];
type AgentStatus = AgentRow['status'];

export const GONE_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'ended',
  'killed',
  'retired',
]);

const ROLE_ORDER: Record<AgentRole, number> = {
  planner: 0,
  driver: 1,
  reviewer: 2,
  builder: 3,
};

export interface AgentLiveness {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  label: string;
}

export interface ProjectLiveness {
  id: string;
  name: string;
  isPaused: boolean;
  isArchived: boolean;
  inVoyage: boolean;
  hasAgents: boolean;
  agents: AgentLiveness[];
  agentsLabel: string;
}

export const isArchived = (project: ProjectRow): boolean =>
  project.archivedAt !== null;

export const listedProjects = (
  projects: readonly ProjectRow[],
  showArchived: boolean,
): ProjectRow[] =>
  projects
    .filter((project) => showArchived || !isArchived(project))
    .toSorted((a, b) => a.name.localeCompare(b.name));

export const shownProjectIds = (
  listed: readonly ProjectRow[],
  picked: readonly string[] | null,
  cap: number = BOARD_PROJECT_CAP,
): string[] => {
  const ids = listed.map(({ id }) => id);
  if (picked === null) return ids.slice(0, cap);
  return ids.filter((id) => picked.includes(id)).slice(0, cap);
};

export const togglePick = (
  picked: readonly string[],
  shown: readonly string[],
  id: string,
  cap: number = BOARD_PROJECT_CAP,
): string[] => {
  if (picked.includes(id)) return picked.filter((other) => other !== id);
  if (shown.length >= cap) return [...picked];
  if (picked.length < cap) return [...picked, id];
  const kept = picked.filter((other) => shown.includes(other));
  return [...kept, id];
};

const byRoleThenName = (a: AgentRow, b: AgentRow): number =>
  ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name);

const agentLiveness = (agent: AgentRow): AgentLiveness => ({
  id: agent.id,
  name: agent.name,
  role: agent.role,
  status: agent.status,
  label: `${agent.name}, ${agent.role}, ${agent.status}`,
});

export const liveAgents = (
  agents: readonly AgentRow[],
  projectId: string,
): AgentLiveness[] =>
  agents
    .filter(
      (agent) =>
        agent.projectId === projectId && !GONE_AGENT_STATUSES.has(agent.status),
    )
    .toSorted(byRoleThenName)
    .map(agentLiveness);

export const projectLiveness = (
  projects: readonly ProjectRow[],
  shownIds: readonly string[],
  agents: readonly AgentRow[],
  voyageSlugs: ReadonlySet<string> = new Set(),
): ProjectLiveness[] =>
  shownIds.flatMap((id) => {
    const project = projects.find((row) => row.id === id);
    if (project === undefined) return [];
    const live = liveAgents(agents, id);
    return [
      {
        id,
        name: project.name,
        isPaused: project.pausedAt !== null,
        isArchived: isArchived(project),
        inVoyage: voyageSlugs.has(project.slug),
        hasAgents: live.length > 0,
        agents: live,
        agentsLabel: `${project.name} agents`,
      },
    ];
  });

const pauseAllResultSchema = z.object({
  paused: z.boolean(),
  projects: z.array(z.string()),
  failed: z.array(z.object({ project: z.string(), error: z.string() })),
});

export type PauseAllResult = z.infer<typeof pauseAllResultSchema>;

export type PauseOutcomeTone = 'done' | 'failed';

export interface PauseOutcome {
  tone: PauseOutcomeTone;
  text: string;
}

const PAUSE_VERBS: Record<'true' | 'false', string> = {
  true: 'Paused',
  false: 'Resumed',
};

const PAUSE_ACTIONS: Record<'true' | 'false', string> = {
  true: 'pause',
  false: 'resume',
};

const projectCount = (count: number): string => {
  if (count === 1) return '1 project';
  return `${count} projects`;
};

const failures = (failed: PauseAllResult['failed']): string =>
  failed.map(({ project, error }) => `${project} (${error})`).join(', ');

export const pauseOutcome = (
  paused: boolean,
  result: unknown,
): PauseOutcome => {
  const verb = PAUSE_VERBS[`${paused}`];
  const parsed = pauseAllResultSchema.safeParse(result);
  if (!parsed.success) return { tone: 'done', text: `${verb} everywhere.` };
  const { projects, failed } = parsed.data;
  const done = `${verb} ${projectCount(projects.length)}.`;
  if (failed.length === 0) return { tone: 'done', text: done };
  return { tone: 'failed', text: `${done} Not reached: ${failures(failed)}.` };
};

export const pauseFailure = (paused: boolean, err: unknown): PauseOutcome => ({
  tone: 'failed',
  text: `Could not ${PAUSE_ACTIONS[`${paused}`]} all: ${getErrorMessage(err)}`,
});
