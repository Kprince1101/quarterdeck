import { useMemo, useState, type ChangeEvent } from 'react';
import { useDeck } from '../../deck/deck.js';
import { valueOf } from '../../grid/dom.js';
import { useIntentRequest } from '../use-intent-request.js';
import { lineDiff, type DiffLine } from './line-diff.js';
import type { ProposalView } from './notebook-model.js';

export interface ProposalCardView {
  label: string;
  isEditing: boolean;
  isViewing: boolean;
  showBody: boolean;
  draft: string;
  diff: DiffLine[];
  canSave: boolean;
  isPending: boolean;
  error: string | null;
  handleApprove: () => void;
  handleReject: () => void;
  handleEdit: () => void;
  handleCancel: () => void;
  handleSave: () => void;
  handleDraftChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}

const shownText = (isEditing: boolean, draft: string, body: string): string => {
  if (isEditing) return draft;
  return body;
};

export const useProposalCard = (proposal: ProposalView): ProposalCardView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  const [isEditing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.body);
  const text = shownText(isEditing, draft, proposal.body);
  const diff = useMemo(
    () => lineDiff(proposal.replaced, text),
    [proposal.replaced, text],
  );
  const decide = (
    decision: 'accepted' | 'rejected',
    edit: { body?: string } = {},
  ) =>
    run(() =>
      intents.notebook.decide({
        project: proposal.project,
        proposalId: proposal.id,
        decision,
        ...edit,
      }),
    );
  return {
    label: `${proposal.opLabel} proposal`,
    isEditing,
    isViewing: !isEditing,
    showBody: !isEditing || proposal.display !== 'text',
    draft,
    diff,
    canSave: draft.trim() !== '' && !isPending,
    isPending,
    error,
    handleApprove: () => {
      void decide('accepted');
    },
    handleReject: () => {
      void decide('rejected');
    },
    handleEdit: () => {
      setDraft(proposal.body);
      setEditing(true);
    },
    handleCancel: () => {
      setEditing(false);
    },
    handleSave: () => {
      void decide('accepted', { body: draft }).then((sent) => {
        if (sent) setEditing(false);
      });
    },
    handleDraftChange: (event) => {
      setDraft(valueOf(event.currentTarget));
    },
  };
};
