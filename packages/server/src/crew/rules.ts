import {
  forgeTerms,
  forgeWording,
  loadRule,
  type Forge,
  type LoadRulesOptions,
  type RuleName,
  type Rules,
} from '@quarterdeck/rules';
import { projectForge, runGit, type GitRunner } from '../gate/index.js';
import { projectSite } from '../planner/rows.js';
import { promptServices, type PromptServices } from '../services/index.js';
import type { Store } from '../store/index.js';

export const DEFAULT_BASE = 'origin/main';

export const NO_VOYAGE_REPO =
  "Set the project's repository path before starting a voyage.";

export class NoRepoPathError extends Error {
  constructor() {
    super(NO_VOYAGE_REPO);
    this.name = 'NoRepoPathError';
  }
}

export interface CrewRules {
  load: <K extends RuleName>(name: K) => Promise<Rules[K]>;
  repoPath: () => Promise<string>;
  forge: () => Promise<Forge>;
  services: () => Promise<PromptServices>;
}

const WORDED_RULES: ReadonlySet<RuleName> = new Set(['charter', 'reviewer']);

export const crewRules = (
  store: Pick<Store, 'db' | 'projectId'>,
  homeDir: string,
  forgeOf?: () => Promise<Forge>,
): CrewRules => {
  const optionalRepoPath = async (): Promise<string | null> =>
    (await projectSite(store.db, store.projectId)).repoPath;

  const options = async (): Promise<LoadRulesOptions> => {
    const repoPath = await optionalRepoPath();
    if (repoPath === null) return { homeDir };
    return { homeDir, repoDir: repoPath };
  };

  const forge = forgeOf ?? (() => projectForge(store, { homeDir }));

  const load = async <K extends RuleName>(name: K): Promise<Rules[K]> => {
    const rule = await loadRule(name, await options());
    if (!WORDED_RULES.has(name) || typeof rule !== 'string') return rule;
    return forgeWording(rule, forgeTerms(await forge())) as Rules[K];
  };

  return {
    load,
    forge,
    services: () => promptServices(store, { homeDir, forge: forgeOf }),
    repoPath: async () => {
      const repoPath = await optionalRepoPath();
      if (repoPath === null) throw new NoRepoPathError();
      return repoPath;
    },
  };
};

export type MachineRules = Pick<CrewRules, 'load'>;

export const machineRules = (homeDir: string): MachineRules => ({
  load: (name) => loadRule(name, { homeDir }),
});

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
