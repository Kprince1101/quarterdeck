import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextIfExists } from '../lib/fs.js';
import { ensurePrivateDir, writePrivateFile } from '../lib/private-fs.js';
import { quarterdeckHome } from '../store/paths.js';
import {
  workspaceSchema,
  type Workspace,
  type WorkspaceMode,
  type WorkspaceProject,
} from '../stream/schema.js';

export const WORKSPACE_FILE = 'workspace.json';

export const workspacePath = (home: string = quarterdeckHome()): string =>
  join(home, WORKSPACE_FILE);

export interface WorkspaceRecord {
  root: string;
  mode: WorkspaceMode;
  projects: WorkspaceProject[];
}

const parseWorkspaceFile = (text: string): Workspace | null => {
  try {
    const parsed = workspaceSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    return null;
  } catch {
    return null;
  }
};

export const readWorkspace = async (
  home: string,
): Promise<Workspace | null> => {
  const text = await readTextIfExists(workspacePath(home));
  if (text === null) return null;
  return parseWorkspaceFile(text);
};

export const writeWorkspace = async (
  home: string,
  record: WorkspaceRecord,
): Promise<Workspace> => {
  const workspace = workspaceSchema.parse({
    ...record,
    updatedAt: new Date().toISOString(),
  });
  const path = workspacePath(home);
  const staged = `${path}.${randomUUID()}.tmp`;
  await ensurePrivateDir(home);
  try {
    await writePrivateFile(staged, `${JSON.stringify(workspace, null, 2)}\n`);
    await rename(staged, path);
  } catch (err) {
    await rm(staged, { force: true });
    throw err;
  }
  return workspace;
};
