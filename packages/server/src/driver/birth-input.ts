import type { Agent } from '../agents/index.js';
import type { Queryable } from '../store/index.js';

export interface NotebookEntry {
  id: string;
  body: string;
  pinned: boolean;
}

export interface Round {
  id: string;
  number: number;
  status: 'planning' | 'active' | 'ended';
  goal: string;
}

export interface BirthInputParts {
  agent: Pick<Agent, 'name'>;
  round: Pick<Round, 'number' | 'goal'>;
  charter: string;
  notebook: readonly NotebookEntry[];
  instructions: string;
}

export const readActiveNotebook = async (
  db: Queryable,
  projectId: string,
): Promise<NotebookEntry[]> => {
  const { rows } = await db.query<NotebookEntry>(
    `select id, body, pinned from notebook
     where project_id = $1
     order by pinned desc, created_at, id`,
    [projectId],
  );
  return rows;
};

const entryHeading = (entry: NotebookEntry, index: number): string => {
  const heading = `### Entry ${index + 1}`;
  if (entry.pinned) return `${heading} (pinned)`;
  return heading;
};

const notebookSection = (notebook: readonly NotebookEntry[]): string => {
  if (notebook.length === 0) return 'The notebook is empty.';
  return [
    'What earlier Drivers wrote down for you, pinned entries first.',
    ...notebook.map(
      (entry, index) => `${entryHeading(entry, index)}\n\n${entry.body.trim()}`,
    ),
  ].join('\n\n');
};

const goalSection = (goal: string): string =>
  goal.trim() || 'No goal is set for this round.';

export const buildBirthInput = (parts: BirthInputParts): string =>
  [
    `You are ${parts.agent.name}, the Driver of this project for round ${parts.round.number}.`,
    parts.charter.trim(),
    `# Round ${parts.round.number}`,
    goalSection(parts.round.goal),
    '# Notebook',
    notebookSection(parts.notebook),
    '# Turn result',
    parts.instructions,
  ].join('\n\n');
