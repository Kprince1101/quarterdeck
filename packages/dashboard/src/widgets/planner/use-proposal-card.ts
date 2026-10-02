import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useDeck } from '../../deck/deck.js';
import { valueOf } from '../../grid/dom.js';
import { useIntentRequest } from '../notebook/use-intent-request.js';
import type { Proposal } from './planner-model.js';

export interface ProposalDraft {
  title: string;
  body: string;
}

export interface ProposalCardView {
  draft: ProposalDraft;
  isBusy: boolean;
  error: string | null;
  hasError: boolean;
  showActions: boolean;
  showEditor: boolean;
  hasBody: boolean;
  hasDependencies: boolean;
  isSaveDisabled: boolean;
  handleApprove: () => void;
  handleReject: () => void;
  handleEdit: () => void;
  handleCancel: () => void;
  handleSave: (event: FormEvent) => void;
  handleTitleChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleBodyChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}

export const useProposalCard = (
  proposal: Proposal,
  project: string,
): ProposalCardView => {
  const { intents } = useDeck();
  const request = useIntentRequest();
  const [isEditing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProposalDraft>({ title: '', body: '' });
  const target = { project, ticketId: proposal.ticketId };

  const decide = (work: () => Promise<unknown>): void => {
    void request.run(work);
  };

  return {
    draft,
    isBusy: request.isPending,
    error: request.error,
    hasError: request.error !== null,
    showActions: proposal.isDecidable && !isEditing,
    showEditor: proposal.isDecidable && isEditing,
    hasBody: proposal.body !== '',
    hasDependencies: proposal.dependsOn.length > 0,
    isSaveDisabled: request.isPending || draft.title.trim() === '',
    handleApprove: () => {
      decide(() => intents.ticket.approve(target));
    },
    handleReject: () => {
      decide(() => intents.ticket.reject(target));
    },
    handleEdit: () => {
      setDraft({ title: proposal.title, body: proposal.body });
      setEditing(true);
    },
    handleCancel: () => {
      setEditing(false);
    },
    handleSave: (event) => {
      event.preventDefault();
      void request
        .run(() => intents.ticket.update({ ...target, ...draft }))
        .then((saved) => {
          if (saved) setEditing(false);
        });
    },
    handleTitleChange: ({ currentTarget }) => {
      const title = valueOf(currentTarget);
      setDraft((current) => ({ ...current, title }));
    },
    handleBodyChange: ({ currentTarget }) => {
      const body = valueOf(currentTarget);
      setDraft((current) => ({ ...current, body }));
    },
  };
};
