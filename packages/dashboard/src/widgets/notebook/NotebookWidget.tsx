import type { ReactNode } from 'react';
import { defineWidget } from '../registry.js';
import { EntryRow } from './EntryRow.js';
import { ProposalCard } from './ProposalCard.js';
import { useNotebookWidget } from './use-notebook-widget.js';
import './notebook.css';

interface NotebookSectionProps {
  title: string;
  emptyText: string;
  isEmpty: boolean;
  children: ReactNode;
}

const NotebookSection = ({
  title,
  emptyText,
  isEmpty,
  children,
}: NotebookSectionProps) => (
  <section className="qd-notebook-section" aria-label={title}>
    <h3 className="qd-notebook-heading">{title}</h3>
    {isEmpty && <p className="qd-empty">{emptyText}</p>}
    <ol className="qd-notebook-list">{children}</ol>
  </section>
);

export const NotebookWidget = () => {
  const { proposals, entries, showProject, noProposals, noEntries } =
    useNotebookWidget();
  return (
    <div className="qd-notebook">
      <NotebookSection
        title="Proposals"
        emptyText="No open proposals."
        isEmpty={noProposals}
      >
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            showProject={showProject}
          />
        ))}
      </NotebookSection>
      <NotebookSection
        title="Active entries"
        emptyText="The notebook is empty."
        isEmpty={noEntries}
      >
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} showProject={showProject} />
        ))}
      </NotebookSection>
    </div>
  );
};

export default defineWidget({
  type: 'notebook',
  title: 'Notebook',
  component: NotebookWidget,
  size: { w: 4, h: 8 },
  minSize: { w: 3, h: 4 },
});
