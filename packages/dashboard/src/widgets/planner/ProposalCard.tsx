import type { JSX } from 'react';
import type { Dependency, Proposal } from './planner-model.js';
import { useProposalCard, type ProposalCardView } from './use-proposal-card.js';

interface ProposalPartProps {
  view: ProposalCardView;
}

const ProposalActions = ({ view }: ProposalPartProps) => (
  <div className="qd-proposal-actions">
    <button
      type="button"
      className="qd-proposal-approve"
      disabled={view.isBusy}
      onClick={view.handleApprove}
    >
      Approve
    </button>
    <button type="button" disabled={view.isBusy} onClick={view.handleEdit}>
      Edit
    </button>
    <button
      type="button"
      className="qd-proposal-reject"
      disabled={view.isBusy}
      onClick={view.handleReject}
    >
      Reject
    </button>
  </div>
);

const ProposalSpec = ({ view }: ProposalPartProps) => (
  <div className="qd-proposal-spec">
    {view.specParts.map(({ part, label, text }) => (
      <section key={part} className="qd-proposal-section" data-part={part}>
        <h4>{label}</h4>
        <p>{text}</p>
      </section>
    ))}
  </div>
);

const BodyField = ({ view }: ProposalPartProps) => (
  <label>
    <span>Body</span>
    <textarea
      rows={6}
      value={view.draft.body}
      disabled={view.isBusy}
      onChange={view.handleBodyChange}
    />
  </label>
);

const SpecFields = ({ view }: ProposalPartProps) =>
  view.specFields.map(({ part, label, text, rows, handleChange }) => (
    <label key={part} data-part={part}>
      <span>{label}</span>
      <textarea
        rows={rows}
        value={text}
        disabled={view.isBusy}
        onChange={handleChange}
      />
    </label>
  ));

const ProposalEditor = ({ view }: ProposalPartProps) => (
  <form className="qd-proposal-editor" onSubmit={view.handleSave}>
    <label>
      <span>Title</span>
      <input
        type="text"
        value={view.draft.title}
        disabled={view.isBusy}
        onChange={view.handleTitleChange}
      />
    </label>
    {view.showSpecFields && <SpecFields view={view} />}
    {view.showBodyField && <BodyField view={view} />}
    <div className="qd-proposal-actions">
      <button
        type="submit"
        className="qd-proposal-approve"
        disabled={view.isSaveDisabled}
      >
        Save
      </button>
      <button type="button" disabled={view.isBusy} onClick={view.handleCancel}>
        Cancel
      </button>
    </div>
  </form>
);

interface DependencyListProps {
  dependencies: Dependency[];
}

const DependencyList = ({ dependencies }: DependencyListProps) => (
  <p className="qd-proposal-deps">
    <span>Depends on</span>
    {dependencies.map(({ id, title }) => (
      <span key={id} className="qd-proposal-dep">
        {title}
      </span>
    ))}
  </p>
);

export interface ProposalCardProps {
  proposal: Proposal;
  project: string;
}

export const ProposalCard = ({
  proposal,
  project,
}: ProposalCardProps): JSX.Element => {
  const view = useProposalCard(proposal, project);
  return (
    <article
      className="qd-proposal"
      aria-label={`Proposed ticket: ${proposal.title}`}
      aria-busy={view.isBusy}
      data-ticket-id={proposal.ticketId}
    >
      <header className="qd-proposal-head">
        <h3>{proposal.title}</h3>
        <span className="qd-proposal-status">{proposal.statusLabel}</span>
      </header>
      {view.hasBody && <p className="qd-proposal-body">{proposal.body}</p>}
      {view.hasSpec && <ProposalSpec view={view} />}
      {view.hasDependencies && (
        <DependencyList dependencies={proposal.dependsOn} />
      )}
      {view.showActions && <ProposalActions view={view} />}
      {view.showEditor && <ProposalEditor view={view} />}
      {view.hasError && (
        <p className="qd-proposal-error" role="alert">
          {view.error}
        </p>
      )}
    </article>
  );
};
