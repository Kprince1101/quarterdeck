import type { Store } from '../store/index.js';
import type { Agent } from './agent.js';
import type { WorktreeDirtyError } from './worktrees.js';

export const DISCARD_WORKTREE_CARD = 'worktree.discard';
export const DISCARD_APPROVED = 'yes';
const DISCARD_OPTIONS = [DISCARD_APPROVED, 'no'];

export class DiscardNotApprovedError extends Error {
  readonly cardId: string;

  constructor(cardId: string, agentName: string) {
    super(`Card ${cardId} is not a yes to discarding ${agentName}'s worktree`);
    this.name = 'DiscardNotApprovedError';
    this.cardId = cardId;
  }
}

export const requestWorktreeDiscard = async (
  store: Store,
  agent: Agent,
  dirty: WorktreeDirtyError,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into cards (project_id, agent_id, kind, question, options)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      store.projectId,
      agent.id,
      DISCARD_WORKTREE_CARD,
      `Discard ${agent.name}'s unsaved work in ${dirty.path}?\n${dirty.summary}`,
      JSON.stringify(DISCARD_OPTIONS),
    ],
  );
  const [card] = rows;
  if (!card)
    throw new Error(`Could not raise a discard card for ${agent.name}`);
  return card.id;
};

export const assertDiscardApproved = async (
  store: Store,
  agent: Agent,
  cardId: string,
): Promise<void> => {
  const { rows } = await store.db.query(
    `select 1 from cards
     where id = $1 and project_id = $2 and agent_id = $3
       and kind = $4 and status = 'answered' and answer = $5`,
    [
      cardId,
      store.projectId,
      agent.id,
      DISCARD_WORKTREE_CARD,
      DISCARD_APPROVED,
    ],
  );
  if (rows.length === 0) throw new DiscardNotApprovedError(cardId, agent.name);
};
