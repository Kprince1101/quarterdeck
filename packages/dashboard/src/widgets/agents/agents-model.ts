import type {
  AgentRow,
  SnapshotTables,
  StreamEvent,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import { relativeTime } from '../events/event-feed.js';
import { heldWorkBy, type HeldWorkView } from './held-work.js';

export type AgentStatus = AgentRow['status'];

export type AgentRole = AgentRow['role'];

type TicketStatus = TicketRow['status'];

export interface AgentTicketView {
  id: string;
  title: string;
  statusLabel: string;
}

export interface AgentView {
  id: string;
  project: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  stateLabel: string;
  updatedAt: string;
  since: string;
  workingOn: string;
  hasWork: boolean;
  tickets: AgentTicketView[];
  held: HeldWorkView[];
  hasHeld: boolean;
  isLive: boolean;
  isPaused: boolean;
}

export interface AgentsModel {
  agents: AgentView[];
  showProject: boolean;
}

const STATE_LABELS: Record<AgentStatus, string> = {
  starting: 'starting',
  idle: 'idle',
  working: 'working',
  paused: 'paused',
  stuck: 'stuck',
  ended: 'ended',
  killed: 'killed',
  retired: 'retired',
};

const TICKET_LABELS: Partial<Record<TicketStatus, string>> = {
  assigned: 'assigned',
  in_progress: 'in progress',
  in_review: 'in review',
  bounced: 'bounced',
  blocked: 'blocked',
};

const TICKET_ORDER: Partial<Record<TicketStatus, number>> = {
  in_progress: 0,
  bounced: 1,
  blocked: 2,
  assigned: 3,
  in_review: 4,
};

const ROLE_ORDER: Record<AgentRole, number> = {
  planner: 0,
  driver: 1,
  reviewer: 2,
  builder: 3,
};

const FINISHED_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'ended',
  'killed',
  'retired',
]);

const byRoleThenName = (a: AgentRow, b: AgentRow): number =>
  ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name);

const byTicketOrder = (a: TicketRow, b: TicketRow): number =>
  (TICKET_ORDER[a.status] ?? 0) - (TICKET_ORDER[b.status] ?? 0) ||
  a.createdAt.localeCompare(b.createdAt);

const isOpenWork = (ticket: TicketRow): boolean =>
  TICKET_LABELS[ticket.status] !== undefined;

const ticketsBy = (tickets: readonly TicketRow[]): Map<string, TicketRow[]> => {
  const byAssignee = new Map<string, TicketRow[]>();
  tickets
    .filter((ticket) => ticket.assigneeId !== null && isOpenWork(ticket))
    .toSorted(byTicketOrder)
    .forEach((ticket) => {
      const assignee = ticket.assigneeId ?? '';
      byAssignee.set(assignee, [...(byAssignee.get(assignee) ?? []), ticket]);
    });
  return byAssignee;
};

const ticketView = (ticket: TicketRow): AgentTicketView => ({
  id: ticket.id,
  title: ticket.title,
  statusLabel: TICKET_LABELS[ticket.status] ?? ticket.status,
});

interface AgentWork {
  tickets: readonly TicketRow[];
  held: HeldWorkView[];
}

const agentView = (
  agent: AgentRow,
  project: string,
  { tickets, held }: AgentWork,
  now: number,
): AgentView => ({
  id: agent.id,
  project,
  name: agent.name,
  role: agent.role,
  status: agent.status,
  stateLabel: STATE_LABELS[agent.status],
  updatedAt: agent.updatedAt,
  since: relativeTime(agent.updatedAt, now),
  workingOn: tickets[0]?.title ?? '',
  hasWork: tickets.length > 0,
  tickets: tickets.map(ticketView),
  held,
  hasHeld: held.length > 0,
  isLive: !FINISHED_STATUSES.has(agent.status),
  isPaused: agent.status === 'paused',
});

export const buildAgents = (
  tables: SnapshotTables,
  events: readonly StreamEvent[],
  now: number,
): AgentsModel => {
  const slugs = new Map(tables.projects.map(({ id, slug }) => [id, slug]));
  const tickets = ticketsBy(tables.tickets);
  const held = heldWorkBy(events);
  const agents = tables.agents
    .filter(
      ({ status, projectId }) => status !== 'retired' && slugs.has(projectId),
    )
    .toSorted(byRoleThenName)
    .map((agent) =>
      agentView(
        agent,
        slugs.get(agent.projectId) ?? '',
        {
          tickets: tickets.get(agent.id) ?? [],
          held: held.get(agent.id) ?? [],
        },
        now,
      ),
    );
  return { agents, showProject: slugs.size > 1 };
};
