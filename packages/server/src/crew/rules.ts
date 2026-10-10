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
import type { WorkspaceMode } from '../stream/schema.js';
import { DEFAULT_WORKSPACE_MODE } from '../workspace/feed.js';
import { workspaceWording } from '../workspace/wording.js';

export const DEFAULT_BASE = 'origin/main';

export const NO_VOYAGE_REPO =
  "Set the project's repository path before starting a voyage.";

export class NoRepoPathError extends Error {
  constructor() {
    super(NO_VOYAGE_REPO);
    this.name = 'NoRepoPathError';
  }
}

export type ModeSource = () => Promise<WorkspaceMode>;

export const multiMode: ModeSource = () =>
  Promise.resolve(DEFAULT_WORKSPACE_MODE);

export interface CrewRules {
  load: <K extends RuleName>(name: K) => Promise<Rules[K]>;
  mode: ModeSource;
  repoPath: () => Promise<string>;
  forge: () => Promise<Forge>;
  services: () => Promise<PromptServices>;
}

const WORDED_RULES: ReadonlySet<RuleName> = new Set(['charter', 'reviewer']);

const inMode = async <K extends RuleName>(
  name: K,
  rule: Rules[K],
  mode: ModeSource,
): Promise<Rules[K]> => {
  if (!WORDED_RULES.has(name) || typeof rule !== 'string') return rule;
  return workspaceWording(rule, await mode()) as Rules[K];
};

export const crewRules = (
  store: Pick<Store, 'db' | 'projectId'>,
  homeDir: string,
  forgeOf?: () => Promise<Forge>,
  mode: ModeSource = multiMode,
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
    const rule = await inMode(
      name,
      await loadRule(name, await options()),
      mode,
    );
    if (!WORDED_RULES.has(name) || typeof rule !== 'string') return rule;
    return forgeWording(rule, forgeTerms(await forge())) as Rules[K];
  };

  return {
    load,
    mode,
    forge,
    services: () => promptServices(store, { homeDir, forge: forgeOf }),
    repoPath: async () => {
      const repoPath = await optionalRepoPath();
      if (repoPath === null) throw new NoRepoPathError();
      return repoPath;
    },
  };
};

export type MachineRules = Pick<CrewRules, 'load' | 'mode'>;

export const machineRules = (
  homeDir: string,
  mode: ModeSource = multiMode,
): MachineRules => ({
  load: async (name) => inMode(name, await loadRule(name, { homeDir }), mode),
  mode,
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
