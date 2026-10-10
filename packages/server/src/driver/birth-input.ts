import type { ForgeTerms } from '@quarterdeck/rules';
import type { Agent } from '../agents/index.js';
import { servicesLines, type PromptServices } from '../services/index.js';
import type { Queryable, Store } from '../store/index.js';
import type { WorkspaceMode } from '../stream/schema.js';

export interface NotebookEntry {
  id: string;
  body: string;
  pinned: boolean;
  global: boolean;
  project?: string;
}

export interface Voyage {
  id: string;
  number: number;
  status: 'planning' | 'active' | 'ended';
  goal: string;
}

export interface BriefTicket {
  id: string;
  title: string;
}

export interface BriefBuilder {
  id: string;
  name: string;
  status: string;
  ticket: BriefTicket | null;
}

export interface ProjectBrief {
  project: string;
  repoPath: string;
  bus: string;
  terms: ForgeTerms;
  waiting: readonly BriefTicket[];
  builders: readonly BriefBuilder[];
  services: PromptServices;
}

export interface BirthInputParts {
  agent: Pick<Agent, 'name'>;
  voyage: Pick<Voyage, 'number' | 'goal'>;
  charter: string;
  notebook: readonly NotebookEntry[];
  projects?: readonly ProjectBrief[];
  mode?: WorkspaceMode;
  instructions: string;
}

export const readActiveNotebook = async (
  db: Queryable,
  projectId: string,
): Promise<NotebookEntry[]> => {
  const { rows } = await db.query<NotebookEntry>(
    `select id, body, pinned, project_id is null as global from notebook
     where (project_id = $1 or project_id is null) and retired_at is null
     order by pinned desc, created_at, id`,
    [projectId],
  );
  return rows;
};

export interface NotebookSource {
  project: string;
  store: Pick<Store, 'db' | 'projectId'>;
}

export interface NotebookRead<S extends NotebookSource> {
  entries: NotebookEntry[];
  owners: Map<string, S>;
}

const pinnedFirst = (a: NotebookEntry, b: NotebookEntry): number =>
  Number(b.pinned) - Number(a.pinned);

export const readNotebooks = async <S extends NotebookSource>(
  sources: readonly S[],
): Promise<NotebookRead<S>> => {
  const owners = new Map<string, S>();
  const entries: NotebookEntry[] = [];
  for (const source of sources) {
    const { db, projectId } = source.store;
    for (const entry of await readActiveNotebook(db, projectId)) {
      if (owners.has(entry.id)) continue;
      owners.set(entry.id, source);
      entries.push({ ...entry, project: source.project });
    }
  }
  return { entries: entries.toSorted(pinnedFirst), owners };
};

export const entryTags = (
  entry: NotebookEntry,
  mode: WorkspaceMode = 'multi',
): string[] => {
  const tags: string[] = [];
  if (entry.pinned) tags.push('pinned');
  if (mode === 'single') return tags;
  if (entry.global) tags.push('every project');
  else if (entry.project) tags.push(entry.project);
  return tags;
};

const entryHeading = (
  entry: NotebookEntry,
  index: number,
  mode: WorkspaceMode,
): string => {
  const heading = `### Entry ${index + 1}`;
  const tags = entryTags(entry, mode);
  if (tags.length === 0) return heading;
  return `${heading} (${tags.join(', ')})`;
};

const notebookSection = (
  notebook: readonly NotebookEntry[],
  mode: WorkspaceMode,
): string => {
  if (notebook.length === 0) return 'The notebook is empty.';
  return [
    'What earlier Drivers wrote down for you, pinned entries first.',
    ...notebook.map(
      (entry, index) =>
        `${entryHeading(entry, index, mode)}\n\n${entry.body.trim()}`,
    ),
  ].join('\n\n');
};

const goalSection = (goal: string): string =>
  goal.trim() || 'No goal is set for this voyage.';

export const briefTicketLabel = (ticket: BriefTicket): string =>
  `"${ticket.title}" (ticket ${ticket.id})`;

const builderLine = (builder: BriefBuilder): string => {
  const who = `- ${builder.name} (builder ${builder.id}), ${builder.status}`;
  if (builder.ticket === null) return `${who}, holding no ticket`;
  return `${who}, on ${briefTicketLabel(builder.ticket)}`;
};

const listOr = (lines: readonly string[], none: string): string => {
  if (lines.length === 0) return none;
  return lines.join('\n');
};

const briefLines = (brief: ProjectBrief): string[] => [
  `Repository: ${brief.repoPath}. Bus: \`${brief.bus}\`. Forge: ${brief.terms.name} (${brief.terms.long}s, ${brief.terms.short}).`,
  'Approved tickets waiting for a builder:',
  listOr(
    brief.waiting.map((ticket) => `- ${briefTicketLabel(ticket)}`),
    'None.',
  ),
  'Builders:',
  listOr(brief.builders.map(builderLine), 'None.'),
  'Services:',
  servicesLines(brief.services),
];

const projectSection = (brief: ProjectBrief): string =>
  [`## ${brief.project}`, ...briefLines(brief)].join('\n\n');

const projectsSection = (
  projects: readonly ProjectBrief[],
  mode: WorkspaceMode,
): string[] => {
  if (projects.length === 0) return [];
  if (mode === 'single')
    return ['# Repository', ...projects.flatMap(briefLines)];
  return [
    '# Projects',
    `This voyage spans ${projects.length} projects. Every ticket and builder belongs to one of them; Quarterdeck finds the project from the ticket or builder you name. Each project has its own bus: use that project's tools for anything about it.`,
    ...projects.map(projectSection),
  ];
};

export interface Birth {
  name: string;
  voyage: number;
}

const BIRTH_LINE =
  /^You are (.+), the Driver of (?:this project|every project|this repository) for (?:voyage|round) (\d+)\.\n/;

export const readBirth = (input: string): Birth | undefined => {
  const match = BIRTH_LINE.exec(input);
  if (!match) return undefined;
  return { name: match[1] ?? '', voyage: Number(match[2]) };
};

export const isBirthInput = (input: string): boolean =>
  readBirth(input) !== undefined;

const DRIVER_OF: Record<'one' | 'many', string> = {
  one: 'this project',
  many: 'every project',
};

const driverOf = (parts: BirthInputParts): string => {
  if (parts.mode === 'single') return 'this repository';
  if (parts.projects === undefined) return DRIVER_OF.one;
  return DRIVER_OF.many;
};

export const kickoffStandards = (parts: BirthInputParts): string =>
  parts.charter.trim();

export const buildBirthInput = (parts: BirthInputParts): string => {
  const mode = parts.mode ?? 'multi';
  return [
    `You are ${parts.agent.name}, the Driver of ${driverOf(parts)} for voyage ${parts.voyage.number}.`,
    kickoffStandards(parts),
    `# Voyage ${parts.voyage.number}`,
    goalSection(parts.voyage.goal),
    ...projectsSection(parts.projects ?? [], mode),
    '# Notebook',
    notebookSection(parts.notebook, mode),
    '# Turn result',
    parts.instructions,
  ].join('\n\n');
};
