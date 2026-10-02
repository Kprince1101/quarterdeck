import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const quarterdeckHome = (): string => join(homedir(), '.quarterdeck');

export const assertProjectSlug = (project: string): string => {
  if (!PROJECT_SLUG.test(project)) {
    throw new Error(`Invalid project slug: ${JSON.stringify(project)}`);
  }
  return project;
};

export const projectDataDir = (
  project: string,
  home: string = quarterdeckHome(),
): string => join(home, assertProjectSlug(project), 'pg');
