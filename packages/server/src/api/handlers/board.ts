import type { Queryable } from '../../store/index.js';
import type { AttachmentRef, BoardIntentName } from '../../intents/index.js';
import { withSavedAttachments } from '../attachments.js';
import type {
  ApiContext,
  IntentHandler,
  IntentHandlers,
  StagedWork,
} from '../context.js';
import { badRequest, conflict } from '../http-error.js';
import {
  applyInProject,
  applyStagedInProject,
  findRow,
  nothingAfterCommit,
} from '../record.js';
import { requireRepoPath } from '../repo-path.js';
import { stageRuleWrite } from '../rule-files.js';
import { IN_PROJECT_OR_GLOBAL, decideNotebook } from './notebook-proposals.js';
import { TICKET_HANDLERS } from './tickets.js';

const openCard = async (tx: Queryable, projectId: string, cardId: string) => {
  const card = await findRow<{ status: string; options: unknown }>(
    tx,
    `select status, options from cards
     where id = $1 and project_id = $2 for update`,
    [cardId, projectId],
    `card ${cardId} not found`,
  );
  if (card.status !== 'open') {
    throw conflict(`card ${cardId} is already ${card.status}`);
  }
  return card;
};

const choicesOf = (options: unknown): string[] => {
  if (!Array.isArray(options)) return [];
  return options.filter((option) => typeof option === 'string');
};

const assertChoice = (options: unknown, answer: string) => {
  const choices = choicesOf(options);
  if (choices.length > 0 && !choices.includes(answer)) {
    throw badRequest(`answer must be one of: ${choices.join(', ')}`);
  }
};

interface CardSettlement {
  status: 'answered' | 'declined';
  answer: string | null;
  attachments: readonly AttachmentRef[];
}

const DECLINED: CardSettlement = {
  status: 'declined',
  answer: null,
  attachments: [],
};

const settleCard = async (
  tx: Queryable,
  cardId: string,
  { status, answer, attachments }: CardSettlement,
) => {
  await tx.query(
    `update cards set status = $2, answer = $3, attachments = $4::jsonb,
       answered_at = now()
     where id = $1`,
    [cardId, status, answer, JSON.stringify(attachments)],
  );
  return { cardId, status };
};

const declineCard: IntentHandler<'card.decline'> = (ctx, input, name) =>
  applyInProject(ctx, name, input, async (tx, projectId) => {
    await openCard(tx, projectId, input.cardId);
    return settleCard(tx, input.cardId, DECLINED);
  });

const answerCard: IntentHandler<'card.answer'> = (ctx, input, name) =>
  withSavedAttachments(ctx, input.project, input.attachments, (attachments) => {
    const recorded = { ...input, attachments };
    return applyInProject(ctx, name, recorded, async (tx, projectId) => {
      const card = await openCard(tx, projectId, input.cardId);
      assertChoice(card.options, input.answer);
      return settleCard(tx, input.cardId, {
        status: 'answered',
        answer: input.answer,
        attachments,
      });
    });
  });

const stageCharter = async (
  ctx: ApiContext,
  tx: Queryable,
  projectId: string,
  body: string,
): Promise<StagedWork> => {
  const repoDir = await requireRepoPath(tx, projectId);
  return stageRuleWrite(
    { name: 'charter', homeDir: ctx.homeDir, repoDir },
    body,
  );
};

const decideCharter: IntentHandler<'charter.decide'> = (ctx, input, name) =>
  applyStagedInProject(ctx, name, input, async (tx, projectId) => {
    const proposal = await findRow<{ status: string; body: string }>(
      tx,
      `select status, body from charter_proposals
       where id = $1 and project_id = $2 for update`,
      [input.proposalId, projectId],
      `charter proposal ${input.proposalId} not found`,
    );
    if (proposal.status !== 'open') {
      throw conflict(
        `charter proposal ${input.proposalId} is already ${proposal.status}`,
      );
    }
    await tx.query(
      `update charter_proposals set status = $2, decided_at = now()
       where id = $1`,
      [input.proposalId, input.decision],
    );
    const result = { proposalId: input.proposalId, decision: input.decision };
    if (input.decision === 'rejected') {
      return { result, afterCommit: nothingAfterCommit };
    }
    const staged = await stageCharter(ctx, tx, projectId, proposal.body);
    return { ...staged, result: { ...result, ...staged.result } };
  });

export const BOARD_HANDLERS: IntentHandlers<BoardIntentName> = {
  'card.answer': answerCard,
  'card.decline': declineCard,
  'notebook.add': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      const entry = await findRow<{ id: string }>(
        tx,
        `insert into notebook (project_id, body, pinned)
         values (case when $4::boolean then null else $1::uuid end, $2, $3)
         returning id`,
        [projectId, input.body, input.pinned, input.global],
        'notebook entry was not created',
      );
      return { entryId: entry.id, global: input.global };
    }),
  'notebook.pin': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      await findRow(
        tx,
        `update notebook set pinned = $3
         where id = $2 and ${IN_PROJECT_OR_GLOBAL} returning id`,
        [projectId, input.entryId, input.pinned],
        `notebook entry ${input.entryId} not found`,
      );
      return { entryId: input.entryId, pinned: input.pinned };
    }),
  'notebook.remove': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      await findRow(
        tx,
        `delete from notebook where id = $2 and ${IN_PROJECT_OR_GLOBAL}
         returning id`,
        [projectId, input.entryId],
        `notebook entry ${input.entryId} not found`,
      );
      return { entryId: input.entryId };
    }),
  'notebook.decide': decideNotebook,
  'charter.decide': decideCharter,
  ...TICKET_HANDLERS,
};
