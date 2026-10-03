import type { Queryable } from '../../store/index.js';
import type { IntentHandler } from '../context.js';
import { badRequest, conflict } from '../http-error.js';
import { applyInProject, findRow } from '../record.js';

type NotebookOp = 'add' | 'update' | 'retire';

interface NotebookProposalRow {
  status: string;
  op: NotebookOp;
  entryId: string | null;
  body: string | null;
  pinned: boolean;
  voyageId: string | null;
  agentId: string | null;
  global: boolean;
}

export const IN_PROJECT_OR_GLOBAL = '(project_id = $1 or project_id is null)';

const entryOwner = (
  projectId: string,
  proposal: NotebookProposalRow,
): string | null => {
  if (proposal.global) return null;
  return projectId;
};

type ApplyProposal = (
  tx: Queryable,
  projectId: string,
  proposal: NotebookProposalRow,
) => Promise<string>;

const lockProposal = async (
  tx: Queryable,
  projectId: string,
  proposalId: string,
): Promise<NotebookProposalRow> => {
  const proposal = await findRow<NotebookProposalRow>(
    tx,
    `select status, op, entry_id as "entryId", body, pinned,
            voyage_id as "voyageId", agent_id as "agentId", global
     from notebook_proposals
     where id = $1 and project_id = $2 for update`,
    [proposalId, projectId],
    `notebook proposal ${proposalId} not found`,
  );
  if (proposal.status !== 'open') {
    throw conflict(
      `notebook proposal ${proposalId} is already ${proposal.status}`,
    );
  }
  return proposal;
};

const activeEntry = async (
  tx: Queryable,
  projectId: string,
  sql: string,
  params: unknown[],
): Promise<string> => {
  const [entryId] = params;
  const { rows } = await tx.query<{ id: string }>(sql, [projectId, ...params]);
  const [row] = rows;
  if (!row) throw conflict(`notebook entry ${String(entryId)} is retired`);
  return row.id;
};

const APPLY: Record<NotebookOp, ApplyProposal> = {
  add: async (tx, projectId, proposal) => {
    const entry = await findRow<{ id: string }>(
      tx,
      `insert into notebook (project_id, voyage_id, author_id, body, pinned)
       values ($1, $2, $3, $4, $5) returning id`,
      [
        entryOwner(projectId, proposal),
        proposal.voyageId,
        proposal.agentId,
        proposal.body,
        proposal.pinned,
      ],
      'notebook entry was not created',
    );
    return entry.id;
  },
  update: (tx, projectId, proposal) =>
    activeEntry(
      tx,
      projectId,
      `update notebook set body = $3
       where ${IN_PROJECT_OR_GLOBAL} and id = $2 and retired_at is null
       returning id`,
      [proposal.entryId, proposal.body],
    ),
  retire: (tx, projectId, proposal) =>
    activeEntry(
      tx,
      projectId,
      `update notebook set retired_at = now()
       where ${IN_PROJECT_OR_GLOBAL} and id = $2 and retired_at is null
       returning id`,
      [proposal.entryId],
    ),
};

const withEditedBody = (
  proposal: NotebookProposalRow,
  body: string | undefined,
): NotebookProposalRow => {
  if (body === undefined) return proposal;
  if (proposal.op === 'retire')
    throw badRequest('a retire proposal has no body to edit');
  return { ...proposal, body };
};

const settleProposal = async (
  tx: Queryable,
  proposalId: string,
  status: 'accepted' | 'rejected',
  body: string | null,
): Promise<void> => {
  await tx.query(
    `update notebook_proposals
     set status = $2, body = $3, decided_at = now()
     where id = $1`,
    [proposalId, status, body],
  );
};

export const decideNotebook: IntentHandler<'notebook.decide'> = (
  ctx,
  input,
  name,
) =>
  applyInProject(ctx, name, input, async (tx, projectId) => {
    const locked = await lockProposal(tx, projectId, input.proposalId);
    const proposal = withEditedBody(locked, input.body);
    const result = {
      proposalId: input.proposalId,
      decision: input.decision,
      op: proposal.op,
    };
    if (input.decision === 'rejected') {
      await settleProposal(tx, input.proposalId, 'rejected', locked.body);
      return result;
    }
    await settleProposal(tx, input.proposalId, 'accepted', proposal.body);
    const entryId = await APPLY[proposal.op](tx, projectId, proposal);
    return { ...result, entryId };
  });
