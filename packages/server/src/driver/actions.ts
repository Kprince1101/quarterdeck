import type { BuilderAction } from './action-schemas.js';
import { assignTicket, type AssignRequest, type Assignment } from './assign.js';
import type { BuilderContext } from './builders.js';
import { continueBuilder, type Continuation } from './continue.js';

export type BuilderActionOutcome =
  | { kind: 'assign'; assignment: Assignment }
  | { kind: 'continue'; continuation: Continuation };

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
