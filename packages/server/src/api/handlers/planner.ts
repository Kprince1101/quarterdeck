import { getErrorMessage } from '../../lib/errors.js';
import { isProjectArchived } from '../../pause/index.js';
import {
  PROPOSAL_MOVED_EVENT,
  ProposalMoveError,
  moveProposal,
  undoMove,
  type MovedProposal,
  type ProposalMove,
} from '../../planner/move.js';
import { publishEvent } from '../../store/index.js';
import { withSavedAttachments } from '../attachments.js';
import type { IntentHandler, IntentHandlers } from '../context.js';
import { conflict, notFound } from '../http-error.js';
import { applyInProject, queueInProject, unrecorded } from '../record.js';

type PlannerIntentName = 'planner.message' | 'planner.new' | 'planner.move';

const queueEverywhere: IntentHandler<'planner.new'> = async (
  ctx,
  _input,
  name,
) => {
  const projects: string[] = [];
  const failed: { project: string; error: string }[] = [];
  for (const project of await ctx.stores.list()) {
    try {
      await queueInProject(ctx, name, { project });
      projects.push(project);
    } catch (err) {
      failed.push({ project, error: getErrorMessage(err) });
    }
  }
  return unrecorded(name, { projects, failed });
};

const move = (proposal: ProposalMove): Promise<MovedProposal> =>
  moveProposal(proposal).catch((err: unknown) => {
    if (!(err instanceof ProposalMoveError)) throw err;
    if (err.missing) throw notFound(err.message);
    throw conflict(err.message);
  });

const moveProposalTo: IntentHandler<'planner.move'> = async (
  ctx,
  input,
  name,
) => {
  await ctx.stores.get(input.project);
  const from = await ctx.stores.get(input.from);
  const to = await ctx.stores.get(input.to);
  if (await isProjectArchived(to.db, to.projectId))
    throw conflict(`project ${input.to} is archived`);
  const proposal: ProposalMove = {
    ticketId: input.ticketId,
    from,
    to,
    title: input.title,
    body: input.body,
  };
  const moved = await move(proposal);
  try {
    return await applyInProject(ctx, name, input, async (tx, projectId) => {
      await publishEvent(tx, projectId, {
        kind: PROPOSAL_MOVED_EVENT,
        payload: {
          ticketId: input.ticketId,
          project: input.from,
          title: moved.title,
          to: { project: input.to, ticketId: moved.ticketId },
        },
      });
      return { ticketId: moved.ticketId, project: input.to };
    });
  } catch (err) {
    await undoMove(proposal, moved);
    throw err;
  }
};

export const PLANNER_HANDLERS: IntentHandlers<PlannerIntentName> = {
  'planner.message': (ctx, input, name) =>
    withSavedAttachments(
      ctx,
      input.project,
      input.attachments,
      (attachments) => {
        const recorded = { ...input, attachments };
        return queueInProject(ctx, name, recorded);
      },
    ),
  'planner.new': queueEverywhere,
  'planner.move': moveProposalTo,
};
