import type { Agent } from '../agents/index.js';
import { pauseLabel, type PauseSubject } from '../pause/index.js';
import type { PublishInput } from '../store/index.js';
import {
  builderTarget,
  claimBuilder,
  promptBuilder,
  withClaim,
  type BuilderContext,
} from './builders.js';
import { BUILDER_CONTINUED_EVENT, flagIfStuck, worktreeHead } from './stuck.js';
import type { TurnRecord } from './turns.js';

export { BUILDER_CONTINUED_EVENT };

export type ContinueContext = Pick<
  BuilderContext,
  'store' | 'sessions' | 'turnsDir' | 'pause'
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

const sendContinue = async (
  ctx: ContinueContext,
  builderId: string,
  prompt: string,
): Promise<Continuation> => {
  const { builder, ticketId } = await claimBuilder(ctx.store, builderId, {
    free: false,
    session: true,
  });
  const target = await withClaim(ctx.store, builder.id, async () => {
    const found = builderTarget(ctx, builder, ticketId);
    const head = await worktreeHead(builder.worktreePath);
    const event: PublishInput = {
      kind: BUILDER_CONTINUED_EVENT,
      agentId: builder.id,
      payload: { name: builder.name, prompt, head },
    };
    if (ticketId !== null) event.ticketId = ticketId;
    await ctx.store.publish(event);
    await flagIfStuck(ctx.store, builder, ticketId, head);
    return found;
  });
  return { builder, ticketId, turn: promptBuilder(target, prompt) };
};

export const continueBuilder = async (
  ctx: ContinueContext,
  request: ContinueRequest,
): Promise<Continuation> => {
  const prompt = request.prompt.trim();
  if (prompt === '') throw new Error('A continue prompt cannot be empty');
  const subject: PauseSubject = {
    operation: 'continue',
    label: pauseLabel('continue', prompt),
    agentId: request.builderId,
  };
  return ctx.pause.hold(subject, () =>
    sendContinue(ctx, request.builderId, prompt),
  );
};
