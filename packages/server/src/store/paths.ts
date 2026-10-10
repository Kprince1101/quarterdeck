import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertProjectSlug } from '../lib/slug.js';

export { assertProjectSlug };

export const quarterdeckHome = (homeDir: string = homedir()): string =>
  join(homeDir, '.quarterdeck');

export const projectDataDir = (
  project: string,
  home: string = quarterdeckHome(),
): string => join(home, assertProjectSlug(project), 'pg');

export const dataDirLockPath = (dataDir: string): string => `${dataDir}.lock`;

export const projectDir = (
  project: string,
  home: string = quarterdeckHome(),
): string => join(home, assertProjectSlug(project));

export const projectTurnsDir = (
  project: string,
  home: string = quarterdeckHome(),
): string => join(home, assertProjectSlug(project), 'turns');

export const projectAttachmentsDir = (
  project: string,
  home: string = quarterdeckHome(),
): string => join(home, assertProjectSlug(project), 'attachments');

export const projectWorktreesDir = (
  project: string,
  home: string = quarterdeckHome(),
): string => join(home, assertProjectSlug(project), 'worktrees');
