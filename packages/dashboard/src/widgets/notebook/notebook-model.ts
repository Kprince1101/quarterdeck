import type {
  NotebookProposalRow,
  NotebookRow,
  SnapshotTables,
} from '@quarterdeck/server/stream-schema';

export type ProposalOp = NotebookProposalRow['op'];

export type ProposalDisplay = 'text' | 'diff' | 'retired';

export interface ProposalView {
  id: string;
  project: string;
  op: ProposalOp;
  opLabel: string;
  display: ProposalDisplay;
  body: string;
  replaced: string;
  rationale: string;
  hasRationale: boolean;
  pinned: boolean;
  canEdit: boolean;
  entryMissing: boolean;
}

export interface EntryView {
  id: string;
  project: string;
  body: string;
  pinned: boolean;
}

export interface NotebookModel {
  proposals: ProposalView[];
  entries: EntryView[];
  showProject: boolean;
}

const OP_LABELS: Record<ProposalOp, string> = {
  add: 'Add',
  update: 'Update',
  retire: 'Retire',
};

const OP_DISPLAYS: Record<ProposalOp, ProposalDisplay> = {
  add: 'text',
  update: 'diff',
  retire: 'retired',
};

const byCreatedAt = (
  a: { createdAt: string },
  b: { createdAt: string },
): number => a.createdAt.localeCompare(b.createdAt);

const pinnedFirst = (a: NotebookRow, b: NotebookRow): number =>
  Number(b.pinned) - Number(a.pinned) || byCreatedAt(a, b);

const proposalView = (
  proposal: NotebookProposalRow,
  project: string,
  entry: NotebookRow | undefined,
): ProposalView => ({
  id: proposal.id,
  project,
  op: proposal.op,
  opLabel: OP_LABELS[proposal.op],
  display: OP_DISPLAYS[proposal.op],
  body: proposal.body ?? '',
  replaced: entry?.body ?? '',
  rationale: proposal.rationale,
  hasRationale: proposal.rationale.trim() !== '',
  pinned: proposal.pinned,
  canEdit: proposal.op !== 'retire',
  entryMissing: proposal.op !== 'add' && entry === undefined,
});

export const buildNotebook = (tables: SnapshotTables): NotebookModel => {
  const slugs = new Map(tables.projects.map(({ id, slug }) => [id, slug]));
  const entries = new Map(tables.notebook.map((entry) => [entry.id, entry]));
  const proposals = tables.notebook_proposals
    .filter(
      ({ status, projectId }) => status === 'open' && slugs.has(projectId),
    )
    .toSorted(byCreatedAt)
    .map((proposal) =>
      proposalView(
        proposal,
        slugs.get(proposal.projectId) ?? '',
        entries.get(proposal.entryId ?? ''),
      ),
    );
  const active = tables.notebook
    .filter(
      ({ retiredAt, projectId }) => retiredAt === null && slugs.has(projectId),
    )
    .toSorted(pinnedFirst)
    .map((entry) => ({
      id: entry.id,
      project: slugs.get(entry.projectId) ?? '',
      body: entry.body,
      pinned: entry.pinned,
    }));
  return { proposals, entries: active, showProject: slugs.size > 1 };
};
