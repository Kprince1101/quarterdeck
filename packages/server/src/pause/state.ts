import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from '../lib/fs.js';
import { ensurePrivateDir, writePrivateFile } from '../lib/private-fs.js';
import { quarterdeckHome, type Queryable } from '../store/index.js';

export type PauseScope = 'global' | 'project' | 'agent';

export const GLOBAL_PAUSE_FILE = 'pause.json';

export const globalPausePath = (home: string = quarterdeckHome()): string =>
  join(home, GLOBAL_PAUSE_FILE);

export const isGloballyPaused = (
  home: string = quarterdeckHome(),
): Promise<boolean> => pathExists(globalPausePath(home));

export const setGlobalPause = async (
  home: string,
  paused: boolean,
): Promise<void> => {
  const path = globalPausePath(home);
  if (!paused) {
    await rm(path, { force: true });
    return;
  }
  if (await pathExists(path)) return;
  await ensurePrivateDir(home);
  const pausedAt = new Date().toISOString();
  await writePrivateFile(path, `${JSON.stringify({ pausedAt })}\n`);
};

export const isProjectArchived = async (
  db: Queryable,
  projectId: string,
): Promise<boolean> => {
  const { rows } = await db.query<{ archived: boolean }>(
    'select archived_at is not null as archived from projects where id = $1',
    [projectId],
  );
  return rows[0]?.archived ?? false;
};

interface PauseRow {
  project: boolean;
  agent: boolean;
}

export const pausedScopes = async (
  db: Queryable,
  projectId: string,
  home: string,
  agentId?: string,
): Promise<PauseScope[]> => {
  const { rows } = await db.query<PauseRow>(
    `select p.paused_at is not null as project,
            coalesce(a.status = 'paused', false) as agent
     from projects p
     left join agents a on a.id = $2::uuid and a.project_id = p.id
     where p.id = $1`,
    [projectId, agentId ?? null],
  );
  const scopes: PauseScope[] = [];
  if (await isGloballyPaused(home)) scopes.push('global');
  if (rows[0]?.project) scopes.push('project');
  if (rows[0]?.agent) scopes.push('agent');
  return scopes;
};
