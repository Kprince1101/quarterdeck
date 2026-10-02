import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_SLUG } from '../lib/slug.js';

export const quarterdeckHome = (homeDir: string = homedir()): string =>
  join(homeDir, '.quarterdeck');

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

export const projectTurnsDir = (
  project: string,
  home: string = quarterdeckHome(),
): string => join(home, assertProjectSlug(project), 'turns');
