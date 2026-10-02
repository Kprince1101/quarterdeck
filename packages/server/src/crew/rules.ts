import {
  loadRule,
  type LoadRulesOptions,
  type RuleName,
  type Rules,
} from '@quarterdeck/rules';
import { runGit, type GitRunner } from '../gate/index.js';
import { projectSite } from '../planner/rows.js';
import type { Store } from '../store/index.js';

export const DEFAULT_BASE = 'origin/main';

export const NO_ROUND_REPO =
  "Set the project's repository path before starting a round.";

export class NoRepoPathError extends Error {
  constructor() {
    super(NO_ROUND_REPO);
    this.name = 'NoRepoPathError';
  }
}

export interface CrewRules {
  load: <K extends RuleName>(name: K) => Promise<Rules[K]>;
  repoPath: () => Promise<string>;
}

export const crewRules = (
  store: Pick<Store, 'db' | 'projectId'>,
  homeDir: string,
): CrewRules => {
  const optionalRepoPath = async (): Promise<string | null> =>
    (await projectSite(store.db, store.projectId)).repoPath;

  const options = async (): Promise<LoadRulesOptions> => {
    const repoPath = await optionalRepoPath();
    if (repoPath === null) return { homeDir };
    return { homeDir, repoDir: repoPath };
  };

  return {
    load: async (name) => loadRule(name, await options()),
    repoPath: async () => {
      const repoPath = await optionalRepoPath();
      if (repoPath === null) throw new NoRepoPathError();
      return repoPath;
    },
  };
};

export const baseRef = async (
  repoPath: string,
  base: string | undefined,
  run: GitRunner = runGit,
): Promise<string> => {
  if (base !== undefined) return `origin/${base}`;
  try {
    const head = await run([
      '-C',
      repoPath,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    return head.trim() || DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
};
