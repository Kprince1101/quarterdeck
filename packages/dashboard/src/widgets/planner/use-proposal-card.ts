import { specBody, type TicketSpec } from '@quarterdeck/server/ticket-spec';
import {
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import { useDeck, useShowsProjects } from '../../deck/DeckProvider.js';
import { valueOf } from '../../grid/dom.js';
import { useIntentRequest } from '../use-intent-request.js';
import {
  SPEC_PART_ROWS,
  STATUS_LABELS,
  specPartViews,
  specParts,
  withSpecPart,
  type ProjectChoice,
  type Proposal,
  type SpecPart,
  type SpecPartView,
} from './planner-model.js';

export interface ProposalDraft {
  project: string;
  title: string;
  body: string;
  spec: TicketSpec | null;
  parts: SpecPart[];
}

export interface SpecFieldView extends SpecPartView {
  rows: number;
  handleChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}

export interface ProjectOptionView {
  slug: string;
  label: string;
}

export interface ProposalCardView {
  showsProjects: boolean;
  draft: ProposalDraft;
  statusLabel: string;
  specParts: SpecPartView[];
  specFields: SpecFieldView[];
  projectOptions: ProjectOptionView[];
  isBusy: boolean;
  error: string | null;
  hasError: boolean;
  showActions: boolean;
  showEdit: boolean;
  showEditor: boolean;
  showSpecFields: boolean;
  showBodyField: boolean;
  hasBody: boolean;
  hasSpec: boolean;
  hasDependencies: boolean;
  isSaveDisabled: boolean;
  handleApprove: () => void;
  handleReject: () => void;
  handleEdit: () => void;
  handleCancel: () => void;
  handleSave: (event: FormEvent) => void;
  handleProjectChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  handleTitleChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleBodyChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}

const EMPTY_DRAFT: ProposalDraft = {
  project: '',
  title: '',
  body: '',
  spec: null,
  parts: [],
};

const partsOf = (spec: TicketSpec | null): SpecPart[] => {
  if (spec === null) return [];
  return specParts(spec);
};

const viewsOf = (spec: TicketSpec | null): SpecPartView[] => {
  if (spec === null) return [];
  return specPartViews(spec);
};

const draftOf = (proposal: Proposal): ProposalDraft => ({
  project: proposal.project,
  title: proposal.title,
  body: proposal.body,
  spec: proposal.spec,
  parts: partsOf(proposal.spec),
});

const draftBody = (draft: ProposalDraft): string => {
  if (draft.spec === null) return draft.body;
  return specBody(draft.spec);
};

const optionsFor = (
  proposal: Proposal,
  projects: readonly ProjectChoice[],
): ProjectOptionView[] => {
  const options = projects.map(({ slug, label }) => ({ slug, label }));
  if (options.some(({ slug }) => slug === proposal.project)) return options;
  return [{ slug: proposal.project, label: proposal.projectLabel }, ...options];
};

const specFieldsOf = (
  draft: ProposalDraft,
  setDraft: Dispatch<SetStateAction<ProposalDraft>>,
): SpecFieldView[] => {
  if (draft.spec === null) return [];
  return specPartViews(draft.spec, draft.parts).map((view) => ({
    ...view,
    rows: SPEC_PART_ROWS[view.part],
    handleChange: ({ currentTarget }) => {
      const text = valueOf(currentTarget);
      setDraft((current) => {
        if (current.spec === null) return current;
        return {
          ...current,
          spec: withSpecPart(current.spec, view.part, text),
        };
      });
    },
  }));
};

export const useProposalCard = (
  proposal: Proposal,
  home: string,
  projects: readonly ProjectChoice[],
): ProposalCardView => {
  const { intents } = useDeck();
  const showsProjects = useShowsProjects();
  const request = useIntentRequest();
  const [isEditing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProposalDraft>(EMPTY_DRAFT);
  const [decided, setDecided] = useState<string | null>(null);
  const target = { project: proposal.project, ticketId: proposal.ticketId };
  const isDecidable = proposal.isDecidable && decided === null;

  const decide = (
    work: () => Promise<unknown>,
    status: keyof typeof STATUS_LABELS,
  ): void => {
    void request.run(work).then((done) => {
      if (done && !proposal.isOnBoard) setDecided(STATUS_LABELS[status]);
    });
  };

  const save = (): Promise<unknown> => {
    const edit = { title: draft.title, body: draftBody(draft) };
    if (draft.project === proposal.project)
      return intents.ticket.update({ ...target, ...edit });
    return intents.planner.move({
      project: home,
      ticketId: proposal.ticketId,
      from: proposal.project,
      to: draft.project,
      ...edit,
    });
  };

  return {
    showsProjects,
    draft,
    statusLabel: decided ?? proposal.statusLabel,
    specParts: viewsOf(proposal.spec),
    specFields: specFieldsOf(draft, setDraft),
    projectOptions: optionsFor(proposal, projects),
    isBusy: request.isPending,
    error: request.error,
    hasError: request.error !== null,
    showActions: isDecidable && !isEditing,
    showEdit: proposal.isOnBoard,
    showEditor: isDecidable && isEditing,
    showSpecFields: draft.spec !== null,
    showBodyField: draft.spec === null,
    hasBody: proposal.spec === null && proposal.body !== '',
    hasSpec: proposal.spec !== null,
    hasDependencies: proposal.dependsOn.length > 0,
    isSaveDisabled: request.isPending || draft.title.trim() === '',
    handleApprove: () => {
      decide(() => intents.ticket.approve(target), 'open');
    },
    handleReject: () => {
      decide(() => intents.ticket.reject(target), 'rejected');
    },
    handleEdit: () => {
      setDraft(draftOf(proposal));
      setEditing(true);
    },
    handleCancel: () => {
      setEditing(false);
    },
    handleSave: (event) => {
      event.preventDefault();
      void request.run(save).then((saved) => {
        if (saved) setEditing(false);
      });
    },
    handleProjectChange: ({ currentTarget }) => {
      const project = valueOf(currentTarget);
      setDraft((current) => ({ ...current, project }));
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
