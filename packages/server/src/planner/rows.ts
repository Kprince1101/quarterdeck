import {
  PROPOSAL_REFUSED_EVENT,
  PROPOSED_EVENT,
} from '../bus/tools/propose.js';
import {
  attachmentRefsOf,
  type AttachmentRef,
} from '../intents/attachments.js';
import { redactSecrets } from '../lib/redact.js';
import type { Queryable } from '../store/index.js';
import type { ProposalDecision } from './brief.js';
import { PROPOSAL_MOVED_EVENT } from './move.js';
import type { OpenProject } from './projects.js';

export const PLANNER_MESSAGE = 'planner.message';
export const PLANNER_NEW = 'planner.new';

export const PLANNER_INTENT_KINDS: readonly string[] = [
  PLANNER_MESSAGE,
  PLANNER_NEW,
];

export interface PlannerIntent {
  id: string;
  kind: string;
  text: string | null;
  attachments: AttachmentRef[];
}

interface PlannerIntentRow {
  id: string;
  kind: string;
  text: string | null;
  attachments: unknown;
}

export interface ProjectSite {
  slug: string;
  repoPath: string | null;
}

export type SettledStatus = 'applied' | 'rejected';

export const projectSite = async (
  db: Queryable,
  projectId: string,
): Promise<ProjectSite> => {
  const { rows } = await db.query<ProjectSite>(
    `select slug, repo_path as "repoPath" from projects where id = $1`,
    [projectId],
  );
  const [site] = rows;
  if (!site) throw new Error(`project ${projectId} is gone`);
  return site;
};

export const pendingPlannerIntents = async (
  db: Queryable,
  projectId: string,
): Promise<PlannerIntent[]> => {
  const { rows } = await db.query<PlannerIntentRow>(
    `select id, kind, input ->> 'text' as text, input -> 'attachments' as attachments
     from intents
     where project_id = $1 and status = 'pending' and kind = any($2::text[])
     order by created_at, id`,
    [projectId, PLANNER_INTENT_KINDS],
  );
  return rows.map((row) => ({
    ...row,
    attachments: attachmentRefsOf(row.attachments),
  }));
};

export const settleIntents = async (
  db: Queryable,
  intentIds: readonly string[],
  status: SettledStatus,
  result: Record<string, unknown>,
): Promise<number> => {
  if (intentIds.length === 0) return 0;
  const { rows } = await db.query<{ id: string }>(
    `update intents set status = $2, result = $3::jsonb, settled_at = now()
     where id = any($1::uuid[]) and status = 'pending'
     returning id`,
    [intentIds, status, JSON.stringify(result)],
  );
  return rows.length;
};

export const settleIntent = async (
  db: Queryable,
  intentId: string,
  status: SettledStatus,
  result: Record<string, unknown>,
): Promise<boolean> =>
  (await settleIntents(db, [intentId], status, result)) > 0;

export const livePlannerIds = async (
  db: Queryable,
  projectId: string,
): Promise<string[]> => {
  const { rows } = await db.query<{ id: string }>(
    `select id from agents
     where project_id = $1 and role = 'planner' and status <> 'retired'
     order by created_at`,
    [projectId],
  );
  return rows.map((row) => row.id);
};

export const setPlannerStatus = async (
  db: Queryable,
  agentId: string,
  status: 'idle' | 'working',
): Promise<void> => {
  await db.query(
    `update agents set status = $2
     where id = $1 and status in ('idle', 'working')`,
    [agentId, status],
  );
};

interface ProposalTrail {
  kind: string;
  title: string;
  project: string | null;
  ticketId: string | null;
  toProject: string | null;
  toTicketId: string | null;
}

interface TrackedProposal {
  ticketId: string;
  project: string;
  title: string;
}

type DecisionStep =
  | { kind: 'moved'; decision: ProposalDecision }
  | { kind: 'proposed'; proposal: TrackedProposal };

const proposalTrail = async (
  db: Queryable,
  projectId: string,
  agentId: string,
): Promise<ProposalTrail[]> => {
  const { rows } = await db.query<ProposalTrail>(
    `select kind, payload ->> 'title' as title,
       payload ->> 'project' as project,
       coalesce(payload ->> 'ticketId', ticket_id::text) as "ticketId",
       payload -> 'to' ->> 'project' as "toProject",
       payload -> 'to' ->> 'ticketId' as "toTicketId"
     from events
     where project_id = $1
       and ((kind = $2 and agent_id = $3) or kind = $4)
     order by id`,
    [projectId, PROPOSED_EVENT, agentId, PROPOSAL_MOVED_EVENT],
  );
  return rows;
};

const decisionSteps = (
  trail: readonly ProposalTrail[],
  home: string,
): DecisionStep[] => {
  const tracked = new Map<string, TrackedProposal>();
  return trail.flatMap((row): DecisionStep[] => {
    if (row.ticketId === null) return [];
    if (row.kind === PROPOSED_EVENT) {
      const proposal = {
        ticketId: row.ticketId,
        project: row.project ?? home,
        title: row.title,
      };
      tracked.set(row.ticketId, proposal);
      return [{ kind: 'proposed', proposal }];
    }
    const from = tracked.get(row.ticketId);
    if (!from || row.toProject === null || row.toTicketId === null) return [];
    tracked.delete(from.ticketId);
    const proposal = {
      ticketId: row.toTicketId,
      project: row.toProject,
      title: row.title,
    };
    tracked.set(row.toTicketId, proposal);
    return [
      {
        kind: 'moved',
        decision: {
          ticketId: row.ticketId,
          title: row.title,
          status: 'moved',
          project: row.toProject,
          movedTo: row.toTicketId,
        },
      },
      { kind: 'proposed', proposal },
    ];
  });
};

const ticketStatuses = async (
  projects: readonly OpenProject[],
  proposals: readonly TrackedProposal[],
): Promise<Map<string, { title: string; status: string }>> => {
  const found = await Promise.all(
    projects.map(async ({ slug, store }) => {
      const ids = proposals
        .filter((proposal) => proposal.project === slug)
        .map(({ ticketId }) => ticketId);
      if (ids.length === 0) return [];
      const { rows } = await store.db.query<{
        id: string;
        title: string;
        status: string;
      }>(
        `select id, title, status from tickets
         where project_id = $1 and id = any($2::uuid[])`,
        [store.projectId, ids],
      );
      return rows;
    }),
  );
  return new Map(found.flat().map(({ id, ...ticket }) => [id, ticket]));
};

export const decidedProposals = async (
  db: Queryable,
  site: { projectId: string; slug: string; agentId: string },
  projects: readonly OpenProject[],
): Promise<ProposalDecision[]> => {
  const steps = decisionSteps(
    await proposalTrail(db, site.projectId, site.agentId),
    site.slug,
  );
  const moved = new Set(
    steps.flatMap((step) => {
      if (step.kind !== 'moved') return [];
      return [step.decision.ticketId];
    }),
  );
  const proposals = steps.flatMap((step) => {
    if (step.kind !== 'proposed' || moved.has(step.proposal.ticketId))
      return [];
    return [step.proposal];
  });
  const statuses = await ticketStatuses(projects, proposals);
  return steps.flatMap((step): ProposalDecision[] => {
    if (step.kind === 'moved') return [step.decision];
    const { ticketId, project } = step.proposal;
    const ticket = statuses.get(ticketId);
    if (moved.has(ticketId) || !ticket || ticket.status === 'proposed')
      return [];
    return [{ ticketId, project, ...ticket }];
  });
};

export interface RefusedProposal {
  title: string;
  problems: string[];
}

interface ProposalOutcome {
  kind: string;
  title: string;
  problems: string[] | null;
}

export const refusedProposals = async (
  db: Queryable,
  projectId: string,
  agentId: string,
  afterEventId: number,
): Promise<RefusedProposal[]> => {
  const { rows } = await db.query<ProposalOutcome>(
    `select kind, payload ->> 'title' as title, payload -> 'problems' as problems
     from events
     where project_id = $1 and agent_id = $2 and id > $3
       and kind = any($4::text[])
     order by id`,
    [
      projectId,
      agentId,
      afterEventId,
      [PROPOSED_EVENT, PROPOSAL_REFUSED_EVENT],
    ],
  );
  return rows.flatMap((row, index) => {
    if (row.kind !== PROPOSAL_REFUSED_EVENT) return [];
    const later = rows.slice(index + 1);
    if (later.some(({ title }) => title === row.title)) return [];
    return [{ title: row.title, problems: row.problems ?? [] }];
  });
};

export const startTurn = async (
  db: Queryable,
  agentId: string,
  seq: number,
  prompt: string,
): Promise<number> => {
  const { rows } = await db.query<{ id: number }>(
    `insert into turns (agent_id, seq, prompt) values ($1, $2, $3)
     returning id`,
    [agentId, seq, redactSecrets(prompt)],
  );
  const [turn] = rows;
  if (!turn) throw new Error(`turn ${seq} was not recorded`);
  return turn.id;
};

export const endTurn = async (
  db: Queryable,
  turnId: number,
  stopReason: string | null,
): Promise<void> => {
  await db.query(
    `update turns set stop_reason = $2, ended_at = now() where id = $1`,
    [turnId, stopReason],
  );
};
