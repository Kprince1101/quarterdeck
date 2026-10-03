import {
  DEFAULT_FORGE,
  forgeOfHost,
  loadRule,
  type Forge,
  type LoadRulesOptions,
} from '@quarterdeck/rules';
import type { Store } from '../store/index.js';
import { ghCli } from './github.js';
import { glabCli } from './gitlab.js';
import { originRepository, projectRepoPath } from './repository.js';

export type PullRequestState = 'open' | 'merged' | 'closed';
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';
export type ChecksState = 'passing' | 'pending' | 'failing' | 'none';
export type ReviewState = 'approved' | 'changes' | 'none';

export interface RepositoryRef {
  hostname: string;
  owner: string;
  name: string;
}

export interface PullRequestRef extends RepositoryRef {
  number: number;
}

export interface BotReview {
  reviewers: string[];
  openThreads: string[];
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
  base: string;
  head: string;
  draft: boolean;
  author: string | null;
  checks: ChecksState;
  review: ReviewState;
  createdAt: string;
}

export interface ForgeHost {
  forge: Forge;
  pullRequestRef: (url: string) => PullRequestRef;
  pullRequest: (url: string) => Promise<PullRequest>;
  squashMerge: (url: string, head: string) => Promise<void>;
  listOpen: (repository: RepositoryRef) => Promise<OpenPullRequest[]>;
}

export type GitRunner = (args: string[]) => Promise<string>;

const FORGE_HOSTS: Record<Forge, () => ForgeHost> = {
  github: () => ghCli(),
  gitlab: () => glabCli(),
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

export interface DetectedForge {
  forge: Forge;
  host: string | null;
}

const UNDETECTED: DetectedForge = { forge: DEFAULT_FORGE, host: null };

export const detectRepoForge = async (
  repoPath: string | null,
  options: RepoForgeOptions = {},
): Promise<DetectedForge> => {
  if (repoPath === null) return UNDETECTED;
  const rules: LoadRulesOptions = { repoDir: repoPath };
  if (options.homeDir !== undefined) rules.homeDir = options.homeDir;
  const { forges } = await loadRule('forges', rules);
  const repository = await originRepository(repoPath, options.run).catch(
    () => undefined,
  );
  if (repository === undefined) return UNDETECTED;
  return {
    forge: forgeOfHost(repository.hostname, forges),
    host: repository.hostname,
  };
};

export const repoForge = async (
  repoPath: string | null,
  options: RepoForgeOptions = {},
): Promise<Forge> => (await detectRepoForge(repoPath, options)).forge;

export const detectProjectForge = async (
  store: Pick<Store, 'db' | 'projectId'>,
  options: RepoForgeOptions = {},
): Promise<DetectedForge> =>
  detectRepoForge(await projectRepoPath(store), options);

export const projectForge = async (
  store: Pick<Store, 'db' | 'projectId'>,
  options: RepoForgeOptions = {},
): Promise<Forge> => repoForge(await projectRepoPath(store), options);

export const mergeForge = async (
  store: Pick<Store, 'db' | 'projectId'>,
  options: RepoForgeOptions = {},
): Promise<Forge> => {
  const repoPath = await projectRepoPath(store);
  if (repoPath === null)
    throw new Error(
      'the project has no repo_path, so the merge gate cannot tell which forge it is on',
    );
  const rules: LoadRulesOptions = { repoDir: repoPath };
  if (options.homeDir !== undefined) rules.homeDir = options.homeDir;
  const repository = await originRepository(repoPath, options.run);
  return repositoryForge(repository, rules);
};
