import {
  DEFAULT_FORGE,
  FORGE_TERMS,
  forgeOfHost,
  loadRule,
  type Forge,
  type LoadRulesOptions,
} from '@quarterdeck/rules';
import type { Store } from '../store/index.js';
import { ghCli } from './github.js';
import { originRepository, projectRepoPath } from './repository.js';

export type PullRequestState = 'open' | 'merged' | 'closed';
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';
export type ChecksState = 'passing' | 'pending' | 'failing' | 'none';

export interface RepositoryRef {
  hostname: string;
  owner: string;
  name: string;
}

export interface PullRequestRef extends RepositoryRef {
  number: number;
}

export interface BotReview {
  reviewed: boolean;
  openThreads: number;
}

export interface PullRequest {
  repository: RepositoryRef;
  base: string;
  defaultBranch: string | null;
  state: PullRequestState;
  head: string;
  draft: boolean;
  mergeable: Mergeable;
  checks: { state: ChecksState; failing: string[] };
  botReview: BotReview;
}

export interface OpenPullRequest {
  url: string;
  number: number;
  title: string;
  branch: string;
  head: string;
  draft: boolean;
  author: string | null;
}

export interface ForgeHost {
  forge: Forge;
  pullRequest: (url: string) => Promise<PullRequest>;
  squashMerge: (url: string, head: string) => Promise<void>;
  listOpen: (repository: RepositoryRef) => Promise<OpenPullRequest[]>;
}

export type GitRunner = (args: string[]) => Promise<string>;

export class ForgeUnavailableError extends Error {
  readonly forge: Forge;

  constructor(forge: Forge) {
    super(`${FORGE_TERMS[forge].name} forge not available yet`);
    this.name = 'ForgeUnavailableError';
    this.forge = forge;
  }
}

const FORGE_HOSTS: Record<Forge, () => ForgeHost> = {
  github: () => ghCli(),
  gitlab: () => {
    throw new ForgeUnavailableError('gitlab');
  },
};

export const forgeHost = (forge: Forge): ForgeHost => FORGE_HOSTS[forge]();

export const repositoryForge = async (
  repository: RepositoryRef,
  rules: LoadRulesOptions,
): Promise<Forge> => {
  const { forges } = await loadRule('forges', rules);
  return forgeOfHost(repository.hostname, forges);
};

export interface RepoForgeOptions {
  homeDir?: string | undefined;
  run?: GitRunner | undefined;
}

export const repoForge = async (
  repoPath: string | null,
  options: RepoForgeOptions = {},
): Promise<Forge> => {
  if (repoPath === null) return DEFAULT_FORGE;
  const repository = await originRepository(repoPath, options.run).catch(
    () => undefined,
  );
  if (repository === undefined) return DEFAULT_FORGE;
  const rules: LoadRulesOptions = { repoDir: repoPath };
  if (options.homeDir !== undefined) rules.homeDir = options.homeDir;
  return repositoryForge(repository, rules);
};

export const projectForge = async (
  store: Pick<Store, 'db' | 'projectId'>,
  options: RepoForgeOptions = {},
): Promise<Forge> => repoForge(await projectRepoPath(store), options);
