import type { ComponentType } from 'react';
import type { DiffLine } from '../line-diff.js';
import { RequestError } from '../RequestError.js';
import { DiffView } from './DiffView.js';
import type { ProposalDisplay, ProposalView } from './notebook-model.js';
import { ProjectTag } from './ProjectTag.js';
import { useProposalCard, type ProposalCardView } from './use-proposal-card.js';

interface ProposalBodyProps {
  proposal: ProposalView;
  diff: DiffLine[];
}

const ProposedText = ({ proposal }: ProposalBodyProps) => (
  <p className="qd-notebook-text">{proposal.body}</p>
);

const ProposedDiff = ({ diff }: ProposalBodyProps) => <DiffView lines={diff} />;

const RetiredText = ({ proposal }: ProposalBodyProps) => (
  <p className="qd-notebook-text qd-notebook-retired">{proposal.replaced}</p>
);

const PROPOSAL_BODIES: Record<
  ProposalDisplay,
  ComponentType<ProposalBodyProps>
> = {
  text: ProposedText,
  diff: ProposedDiff,
  retired: RetiredText,
};

interface ProposalActionsProps {
  card: ProposalCardView;
  canEdit: boolean;
}

const ViewActions = ({ card, canEdit }: ProposalActionsProps) => (
  <div className="qd-notebook-actions">
    <button
      type="button"
      disabled={card.isPending}
      onClick={card.handleApprove}
    >
      Approve
    </button>
    {canEdit && (
      <button type="button" disabled={card.isPending} onClick={card.handleEdit}>
        Edit
      </button>
    )}
    <button type="button" disabled={card.isPending} onClick={card.handleReject}>
      Reject
    </button>
  </div>
);

const EditActions = ({ card }: ProposalActionsProps) => (
  <div className="qd-notebook-actions">
    <button type="button" disabled={!card.canSave} onClick={card.handleSave}>
      Approve edit
    </button>
    <button type="button" disabled={card.isPending} onClick={card.handleCancel}>
      Cancel
    </button>
  </div>
);

export interface ProposalCardProps {
  proposal: ProposalView;
  showProject: boolean;
}

export const ProposalCard = ({ proposal, showProject }: ProposalCardProps) => {
  const card = useProposalCard(proposal);
  const Body = PROPOSAL_BODIES[proposal.display];
  return (
    <li
      className="qd-notebook-proposal"
      aria-label={card.label}
      data-proposal-id={proposal.id}
      data-op={proposal.op}
    >
      <div className="qd-notebook-proposal-head">
        <span className="qd-notebook-op">{proposal.opLabel}</span>
        <ProjectTag project={proposal.project} isShown={showProject} />
        {proposal.pinned && <span className="qd-notebook-flag">pinned</span>}
      </div>
      {card.isEditing && (
        <textarea
          className="qd-notebook-draft"
          aria-label="Proposed text"
          value={card.draft}
          onChange={card.handleDraftChange}
        />
      )}
      {card.showBody && <Body proposal={proposal} diff={card.diff} />}
      {proposal.entryMissing && (
        <p className="qd-notebook-note">The entry it changes is gone.</p>
      )}
      {proposal.hasRationale && (
        <p className="qd-notebook-note">{proposal.rationale}</p>
      )}
      <RequestError error={card.error} />
      {card.isViewing && <ViewActions card={card} canEdit={proposal.canEdit} />}
      {card.isEditing && <EditActions card={card} canEdit={proposal.canEdit} />}
    </li>
  );
};
