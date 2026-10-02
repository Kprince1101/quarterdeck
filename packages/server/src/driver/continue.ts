import type { Agent } from '../agents/index.js';
import { assertLaunchBudget } from '../budget/index.js';
import type { PublishInput } from '../store/index.js';
import {
  builderTarget,
  claimBuilder,
  promptBuilder,
  withClaim,
  type BuilderContext,
} from './builders.js';
import type { TurnRecord } from './turns.js';

export const BUILDER_CONTINUED_EVENT = 'builder.continued';

export type ContinueContext = Pick<
  BuilderContext,
  'store' | 'sessions' | 'turnsDir' | 'budget'
>;

export interface ContinueRequest {
  builderId: string;
  prompt: string;
}

export interface Continuation {
  builder: Agent;
  ticketId: string | null;
  turn: Promise<TurnRecord>;
}

export const continueBuilder = async (
  ctx: ContinueContext,
  request: ContinueRequest,
): Promise<Continuation> => {
  const prompt = request.prompt.trim();
  if (prompt === '') throw new Error('A continue prompt cannot be empty');
  await assertLaunchBudget(ctx.store, ctx.budget, {
    agentId: request.builderId,
  });
  const { builder, ticketId } = await claimBuilder(
    ctx.store,
    request.builderId,
    { free: false, session: true },
  );
  const target = await withClaim(ctx.store, builder.id, async () => {
    const found = builderTarget(ctx, builder, ticketId);
    const event: PublishInput = {
      kind: BUILDER_CONTINUED_EVENT,
      agentId: builder.id,
      payload: { name: builder.name, prompt },
    };
    if (ticketId !== null) event.ticketId = ticketId;
    await ctx.store.publish(event);
    return found;
  });
  return { builder, ticketId, turn: promptBuilder(target, prompt) };
};
