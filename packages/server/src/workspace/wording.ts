import type { WorkspaceMode } from '../stream/schema.js';

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'multi';

export const switchNotice = (count: number): string =>
  `Workspace switched to multi mode: it now has ${count} repositories, and each one is a project.`;

export const MULTI_ONLY = '<!-- multi -->';
export const SINGLE_ONLY = '<!-- single -->';

const TAGS: Record<WorkspaceMode, { keep: string; drop: string }> = {
  multi: { keep: MULTI_ONLY, drop: SINGLE_ONLY },
  single: { keep: SINGLE_ONLY, drop: MULTI_ONLY },
};

const REPOSITORY: Record<string, string> = {
  project: 'repository',
  projects: 'repositories',
  Project: 'Repository',
  Projects: 'Repositories',
  PROJECT: 'REPOSITORY',
  PROJECTS: 'REPOSITORIES',
};

const PROJECT_WORD =
  /(?<![`"'_\-./])\b(project|projects)\b(?![`"_\-(/]|'(?!s\b))/gi;

export const repositoryWording = (text: string): string =>
  text.replace(PROJECT_WORD, (word) => REPOSITORY[word] ?? word);

const resolveTags = (text: string, mode: WorkspaceMode): string => {
  const { keep, drop } = TAGS[mode];
  const lines = text.split('\n');
  const kept = lines
    .filter((line) => !line.includes(drop))
    .map((line) => {
      if (!line.includes(keep)) return line;
      return line.replace(keep, '').trimEnd();
    })
    .join('\n');
  if (!text.includes(drop)) return kept;
  return kept.replaceAll(/\n{3,}/g, '\n\n').trim();
};

export const workspaceWording = (text: string, mode: WorkspaceMode): string => {
  const resolved = resolveTags(text, mode);
  if (mode === 'multi') return resolved;
  return repositoryWording(resolved);
};

export const multiOnly = (line: string): string => `${line} ${MULTI_ONLY}`;

export const singleOnly = (line: string): string => `${line} ${SINGLE_ONLY}`;

export const byMode = <T>(
  mode: WorkspaceMode,
  variants: Record<WorkspaceMode, T>,
): T => variants[mode];
