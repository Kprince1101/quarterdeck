import type {
  BuilderAction,
  TicketAction,
  TurnAction,
} from './action-schemas.js';
import { assignTicket, type AssignRequest, type Assignment } from './assign.js';
import type { BuilderContext } from './builders.js';
import { continueBuilder, type Continuation } from './continue.js';
import { storeDependencies } from './dependencies.js';
import {
  blockTicket,
  recordPublished,
  type Block,
  type BlockRequest,
} from './holds.js';
import type { BuilderTicket } from './tickets.js';

export type BuilderActionOutcome =
  | { kind: 'assign'; assignment: Assignment }
  | { kind: 'continue'; continuation: Continuation };

export type TicketActionOutcome =
  | { kind: 'block'; block: Block }
  | {
      kind: 'published';
      ticket: BuilderTicket;
      package: string;
      version: string;
    };

export type TurnActionOutcome = BuilderActionOutcome | TicketActionOutcome;

const assign = async (
  ctx: BuilderContext,
  ticketId: string,
  builderId: string | undefined,
): Promise<BuilderActionOutcome> => {
  const request: AssignRequest = { ticketId };
  if (builderId !== undefined) request.builderId = builderId;
  return { kind: 'assign', assignment: await assignTicket(ctx, request) };
};

export const applyBuilderAction = async (
  ctx: BuilderContext,
  action: BuilderAction,
): Promise<BuilderActionOutcome> => {
  if (action.kind === 'assign')
    return assign(ctx, action.ticket, action.builder);
  const continuation = await continueBuilder(ctx, {
    builderId: action.builder,
    prompt: action.prompt,
  });
  return { kind: 'continue', continuation };
};

export const applyTicketAction = async (
  ctx: Pick<BuilderContext, 'store' | 'dependencies'>,
  action: TicketAction,
): Promise<TicketActionOutcome> => {
  if (action.kind === 'published') {
    const ticket = await recordPublished(ctx.store, {
      ticketId: action.ticket,
      package: action.package,
      version: action.version,
    });
    return {
      kind: 'published',
      ticket,
      package: action.package,
      version: action.version,
    };
  }
  const request: BlockRequest = { ticketId: action.ticket, on: action.on };
  if (action.note !== undefined) request.note = action.note;
  const dependencies = ctx.dependencies ?? storeDependencies(() => [ctx.store]);
  return {
    kind: 'block',
    block: await blockTicket(ctx.store, dependencies, request),
  };
};

export const applyTurnAction = (
  ctx: BuilderContext,
  action: TurnAction,
): Promise<TurnActionOutcome> => {
  if (action.kind === 'block' || action.kind === 'published')
    return applyTicketAction(ctx, action);
  return applyBuilderAction(ctx, action);
};
