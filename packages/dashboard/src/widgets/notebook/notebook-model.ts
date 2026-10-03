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
  scope: string;
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
  scope: string;
  body: string;
  pinned: boolean;
}

export interface NotebookModel {
  proposals: ProposalView[];
  entries: EntryView[];
  showProject: boolean;
}

export const EVERY_PROJECT = 'every project';

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

interface Owner {
  project: string;
  scope: string;
}

const byCreatedAt = (
  a: { createdAt: string },
  b: { createdAt: string },
): number => a.createdAt.localeCompare(b.createdAt);

const pinnedFirst = (a: NotebookRow, b: NotebookRow): number =>
  Number(b.pinned) - Number(a.pinned) || byCreatedAt(a, b);

const proposalView = (
  proposal: NotebookProposalRow,
  owner: Owner,
  entry: NotebookRow | undefined,
): ProposalView => ({
  id: proposal.id,
  ...owner,
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

const scopeOf = (project: string, global: boolean): string => {
  if (global) return EVERY_PROJECT;
  return project;
};

const entryOwner = (
  slugs: ReadonlyMap<string, string>,
  projectId: string | null,
): Owner | undefined => {
  if (projectId !== null) {
    const project = slugs.get(projectId);
    if (project === undefined) return undefined;
    return { project, scope: project };
  }
  const [project] = slugs.values();
  if (project === undefined) return undefined;
  return { project, scope: EVERY_PROJECT };
};

const proposalOwner = (
  slugs: ReadonlyMap<string, string>,
  proposal: NotebookProposalRow,
): Owner => {
  const project = slugs.get(proposal.projectId) ?? '';
  return { project, scope: scopeOf(project, proposal.global) };
};

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
        proposalOwner(slugs, proposal),
        entries.get(proposal.entryId ?? ''),
      ),
    );
  const active = tables.notebook
    .filter(({ retiredAt }) => retiredAt === null)
    .toSorted(pinnedFirst)
    .flatMap((entry) => {
      const owner = entryOwner(slugs, entry.projectId);
      if (owner === undefined) return [];
      return [
        { id: entry.id, ...owner, body: entry.body, pinned: entry.pinned },
      ];
    });
  const hasGlobal = [...active, ...proposals].some(
    ({ scope }) => scope === EVERY_PROJECT,
  );
  return {
    proposals,
    entries: active,
    showProject: slugs.size > 1 || hasGlobal,
  };
};
