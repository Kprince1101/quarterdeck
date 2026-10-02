import { join } from 'node:path';
import {
  AGENT_COLUMNS,
  attachWorktree,
  detachWorktree,
  findAgent,
  replaceSession,
  type Agent,
  type BirthRequest,
} from '../agents/index.js';
import { assertLaunchBudget } from '../budget/index.js';
import { publishEvent } from '../store/index.js';
import { buildAssignmentPrompt } from './assignment-prompt.js';
import {
  builderTarget,
  claimBuilder,
  promptBuilder,
  withClaim,
  type BuilderContext,
} from './builders.js';
import { AgentNotRetiredError, TicketNotAssignableError } from './errors.js';
import {
  ACTIVE_TICKET_STATUSES,
  APPROVED_TICKET_STATUS,
  TICKET_COLUMNS,
  findApprovedTicket,
  heldTickets,
  type BuilderTicket,
} from './tickets.js';
import type { TurnRecord } from './turns.js';

export const TICKET_ASSIGNED_EVENT = 'ticket.assigned';

export interface AssignRequest {
  ticketId: string;
  builderId?: string;
}

export interface Assignment {
  ticket: BuilderTicket;
  builder: Agent;
  worktreePath: string;
  born: boolean;
  previousAssigneeId: string | null;
  turn: Promise<TurnRecord>;
}

interface PlacedBuilder {
  builder: Agent;
  born: boolean;
}

export const builderWorktreePath = (
  worktreesDir: string,
  builderName: string,
  ticketId: string,
): string => join(worktreesDir, `${builderName}-${ticketId.slice(0, 8)}`);

const addWorktree = (ctx: BuilderContext, path: string): Promise<void> =>
  ctx.worktrees.add({ repoPath: ctx.repoPath, path, base: ctx.base });

const undoWorktree = async (
  ctx: BuilderContext,
  path: string,
  err: unknown,
): Promise<never> => {
  try {
    await ctx.worktrees.remove(path);
  } catch (cleanupError) {
    throw new AggregateError(
      [err, cleanupError],
      `the builder could not be born and its worktree ${path} could not be removed`,
    );
  }
  throw err;
};

const birthBuilder = async (
  ctx: BuilderContext,
  ticket: BuilderTicket,
): Promise<PlacedBuilder> => {
  let added: string | undefined;
  const prepare = async (agent: Agent): Promise<Agent> => {
    const path = builderWorktreePath(ctx.worktreesDir, agent.name, ticket.id);
    await addWorktree(ctx, path);
    added = path;
    return attachWorktree(ctx.store, agent, path);
  };
  const request: BirthRequest = {
    store: ctx.store,
    role: 'builder',
    runtime: ctx.runtime,
    ticketId: ticket.id,
    prepare,
  };
  if (ctx.roundId !== undefined) request.roundId = ctx.roundId;
  try {
    return { builder: await ctx.lifecycle.birth(request), born: true };
  } catch (err) {
    if (added === undefined) throw err;
    return undoWorktree(ctx, added, err);
  }
};

const moveWorktree = async (
  ctx: BuilderContext,
  agent: Agent,
  path: string,
): Promise<Agent> => {
  let builder = agent;
  if (builder.worktreePath !== null && builder.worktreePath !== path) {
    await ctx.worktrees.remove(builder.worktreePath);
    builder = await detachWorktree(
      ctx.store,
      builder,
      builder.worktreePath,
      false,
    );
  }
  if (builder.worktreePath === path) return builder;
  await addWorktree(ctx, path);
  return attachWorktree(ctx.store, builder, path);
};

const reopenSession = async (
  ctx: BuilderContext,
  agent: Agent,
): Promise<Agent> => {
  let builder = agent;
  if (builder.sessionId !== null) {
    await ctx.sessions.close(builder.sessionId);
    builder = await replaceSession(ctx.store, builder, null);
  }
  return replaceSession(ctx.store, builder, await ctx.sessions.open(builder));
};

const moveBuilder = async (
  ctx: BuilderContext,
  builderId: string,
  ticket: BuilderTicket,
): Promise<PlacedBuilder> => {
  await assertLaunchBudget(ctx.store, ctx.budget, {
    agentId: builderId,
    ticketId: ticket.id,
  });
  const { builder } = await claimBuilder(ctx.store, builderId, {
    free: true,
    session: false,
  });
  return withClaim(ctx.store, builderId, async () => {
    const path = builderWorktreePath(ctx.worktreesDir, builder.name, ticket.id);
    const moved = await moveWorktree(ctx, builder, path);
    return { builder: await reopenSession(ctx, moved), born: false };
  });
};

const placeBuilder = (
  ctx: BuilderContext,
  ticket: BuilderTicket,
  builderId: string | undefined,
): Promise<PlacedBuilder> => {
  if (builderId === undefined) return birthBuilder(ctx, ticket);
  return moveBuilder(ctx, builderId, ticket);
};

const handoverStatuses = (
  previousAssigneeId: string | null,
): readonly string[] => {
  if (previousAssigneeId === null) return [APPROVED_TICKET_STATUS];
  return ACTIVE_TICKET_STATUSES;
};

const recordAssignment = (
  ctx: BuilderContext,
  placed: PlacedBuilder,
  ticket: BuilderTicket,
  previousAssigneeId: string | null,
): Promise<{ ticket: BuilderTicket; builder: Agent }> =>
  ctx.store.db.transaction(async (tx) => {
    const tickets = await tx.query<BuilderTicket>(
      `update tickets
       set assignee_id = $3,
           status = case when status in ('open', 'in_progress', 'blocked')
                    then 'assigned' else status end
       where id = $1 and project_id = $2
         and assignee_id is not distinct from $4 and status = any($5)
       returning ${TICKET_COLUMNS}`,
      [
        ticket.id,
        ctx.store.projectId,
        placed.builder.id,
        previousAssigneeId,
        handoverStatuses(previousAssigneeId),
      ],
    );
    const [assigned] = tickets.rows;
    if (!assigned)
      throw new TicketNotAssignableError(
        ticket.id,
        'it changed while its builder was being prepared',
      );
    const agents = await tx.query<Agent>(
      `update agents set status = 'working'
       where id = $1 and status in ('idle', 'working')
       returning ${AGENT_COLUMNS}`,
      [placed.builder.id],
    );
    const [builder] = agents.rows;
    if (!builder)
      throw new TicketNotAssignableError(
        ticket.id,
        `its builder ${placed.builder.name} stopped while being prepared`,
      );
    await publishEvent(tx, ctx.store.projectId, {
      kind: TICKET_ASSIGNED_EVENT,
      agentId: builder.id,
      ticketId: assigned.id,
      payload: {
        name: builder.name,
        worktreePath: builder.worktreePath,
        born: placed.born,
        previousAssigneeId,
      },
    });
    return { ticket: assigned, builder };
  });

const handOver = async (
  ctx: BuilderContext,
  ticket: BuilderTicket,
  builderId: string | undefined,
  previousAssigneeId: string | null,
): Promise<Assignment> => {
  const placed = await placeBuilder(ctx, ticket, builderId);
  const recorded = await withClaim(ctx.store, placed.builder.id, async () => {
    const target = builderTarget(ctx, placed.builder, ticket.id);
    const done = await recordAssignment(
      ctx,
      placed,
      ticket,
      previousAssigneeId,
    );
    return { ...done, target };
  });
  const worktreePath = builderWorktreePath(
    ctx.worktreesDir,
    recorded.builder.name,
    ticket.id,
  );
  const input = buildAssignmentPrompt({
    builder: recorded.builder,
    ticket: recorded.ticket,
    worktreePath,
    repoPath: ctx.repoPath,
    base: ctx.base,
  });
  return {
    ticket: recorded.ticket,
    builder: recorded.builder,
    worktreePath,
    born: placed.born,
    previousAssigneeId,
    turn: promptBuilder(recorded.target, input),
  };
};

export const assignTicket = async (
  ctx: BuilderContext,
  request: AssignRequest,
): Promise<Assignment> => {
  const ticket = await findApprovedTicket(ctx.store, request.ticketId);
  return handOver(ctx, ticket, request.builderId, null);
};

export const reassignTickets = async (
  ctx: BuilderContext,
  retiredId: string,
): Promise<Assignment[]> => {
  const retired = await findAgent(ctx.store, retiredId);
  if (retired.status !== 'retired')
    throw new AgentNotRetiredError(retiredId, retired.status);
  const tickets = await heldTickets(ctx.store, retiredId);
  const assignments: Assignment[] = [];
  for (const ticket of tickets) {
    assignments.push(await handOver(ctx, ticket, undefined, retiredId));
  }
  return assignments;
};
