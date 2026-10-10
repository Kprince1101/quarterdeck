import { basename } from 'node:path';
import {
  RULE_NAMES,
  machineProfilesDir,
  ruleLayerPaths,
} from '@quarterdeck/rules';
import { claudeRuntimeDir } from '../acp/runtimes/claude/adapter.js';
import { claudeAuthPath } from '../acp/runtimes/claude/auth.js';
import { defaultGeminiDir } from '../acp/runtimes/gemini/lockdown.js';
import { defaultKiroProcessDir } from '../acp/runtimes/kiro/config.js';
import { busSocketDir } from '../bus/socket.js';
import type {
  DataPathEntry,
  DataPathKind,
  DataPathScope,
} from '../intents/index.js';
import { pathExists } from '../lib/fs.js';
import { globalPausePath } from '../pause/state.js';
import {
  dataDirLockPath,
  projectAttachmentsDir,
  projectDataDir,
  projectTurnsDir,
  projectWorktreesDir,
  quarterdeckHome,
} from '../store/paths.js';
import { ticketPluginsDir } from '../tickets/plugins.js';
import { workspacePath } from '../workspace/file.js';

export type DataPath = Omit<DataPathEntry, 'exists'>;

export interface DataPathOptions {
  homeDir: string;
  project: string;
  repoPath?: string | null | undefined;
  database?: string | undefined;
}

const entry = (
  label: string,
  path: string,
  kind: DataPathKind,
  scope: DataPathScope,
): DataPath => ({ label, path, kind, scope });

const storePaths = (
  project: string,
  home: string,
  database: string | undefined,
): DataPath[] => {
  if (database !== undefined) {
    return [entry('Postgres database', database, 'database', 'project')];
  }
  const dataDir = projectDataDir(project, home);
  return [
    entry('Postgres data', dataDir, 'directory', 'project'),
    entry('Store lock', dataDirLockPath(dataDir), 'file', 'project'),
  ];
};

const ruleFiles = (dir: string, scope: DataPathScope): DataPath[] =>
  RULE_NAMES.map((name) => {
    const [path = ''] = ruleLayerPaths(name, { homeDir: dir }).local;
    return entry(basename(path), path, 'file', scope);
  });

const repoRuleFiles = (repoPath: string | null | undefined): DataPath[] => {
  if (repoPath === null || repoPath === undefined) return [];
  return ruleFiles(repoPath, 'repo');
};

export const dataPaths = ({
  homeDir,
  project,
  repoPath,
  database,
}: DataPathOptions): DataPath[] => {
  const home = quarterdeckHome(homeDir);
  return [
    ...storePaths(project, home, database),
    entry('Turn files', projectTurnsDir(project, home), 'directory', 'project'),
    entry(
      'Worktrees',
      projectWorktreesDir(project, home),
      'directory',
      'project',
    ),
    entry(
      'Attachments',
      projectAttachmentsDir(project, home),
      'directory',
      'project',
    ),
    ...repoRuleFiles(repoPath),
    ...ruleFiles(homeDir, 'machine'),
    entry(
      'Rules profiles',
      machineProfilesDir(homeDir),
      'directory',
      'machine',
    ),
    entry('Ticket plugins', ticketPluginsDir(home), 'directory', 'machine'),
    entry('Workspace', workspacePath(home), 'file', 'machine'),
    entry('Global pause', globalPausePath(home), 'file', 'machine'),
    entry('Bus sockets', busSocketDir(home), 'directory', 'machine'),
    entry('Kiro runtime', defaultKiroProcessDir(home), 'directory', 'machine'),
    entry('Gemini runtime', defaultGeminiDir(home), 'directory', 'machine'),
    entry('Claude runtime', claudeRuntimeDir(home), 'directory', 'machine'),
    entry('Claude auth mode', claudeAuthPath(home), 'file', 'machine'),
  ];
};

const presence = async (path: DataPath): Promise<DataPathEntry> => {
  if (path.kind === 'database') return { ...path, exists: true };
  return { ...path, exists: await pathExists(path.path) };
};

export const withPresence = (paths: DataPath[]): Promise<DataPathEntry[]> =>
  Promise.all(paths.map(presence));
