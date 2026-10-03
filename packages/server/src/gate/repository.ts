import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from '../store/index.js';
import type { GitRunner, RepositoryRef } from './forge.js';

const SCP_REMOTE =
  /^[^@/:]+@([^:/]+):\/?([^/]+(?:\/[^/]+)*)\/([^/]+?)(?:\.git)?\/?$/;
const PATH_REMOTE = /^\/([^/]+(?:\/[^/]+)*)\/([^/]+?)(?:\.git)?\/?$/;
const REMOTE_PROTOCOLS: readonly string[] = ['https:', 'http:', 'ssh:'];

const parseUrlRemote = (remote: string): RepositoryRef | undefined => {
  const parsed = URL.parse(remote);
  if (!parsed || !REMOTE_PROTOCOLS.includes(parsed.protocol)) return undefined;
  const match = PATH_REMOTE.exec(parsed.pathname);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    hostname: parsed.hostname.toLowerCase(),
    owner: match[1],
    name: match[2],
  };
};

export const parseRemoteUrl = (remote: string): RepositoryRef => {
  const trimmed = remote.trim();
  const scp = SCP_REMOTE.exec(trimmed);
  if (scp?.[1] && scp[2] && scp[3])
    return { hostname: scp[1].toLowerCase(), owner: scp[2], name: scp[3] };
  const fromUrl = parseUrlRemote(trimmed);
  if (fromUrl) return fromUrl;
  throw new Error(
    `${trimmed} is not a repository remote with a host, owner and name`,
  );
};

export const sameRepository = (a: RepositoryRef, b: RepositoryRef): boolean =>
  a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.name.toLowerCase() === b.name.toLowerCase();

export const repositoryName = (repo: RepositoryRef): string =>
  `${repo.hostname}/${repo.owner}/${repo.name}`;

export const exec = promisify(execFile);

export const execError = (command: string, err: unknown): Error => {
  const stderr = (err as { stderr?: unknown }).stderr;
  let detail = String(err);
  if (typeof stderr === 'string' && stderr.trim() !== '')
    detail = stderr.trim();
  else if (err instanceof Error) detail = err.message;
  return new Error(`${command} failed: ${detail}`, { cause: err });
};

export const runGit: GitRunner = async (args) => {
  try {
    const { stdout } = await exec('git', args);
    return stdout;
  } catch (err) {
    throw execError(`git ${args.join(' ')}`, err);
  }
};

export const originRepository = async (
  repoPath: string,
  run: GitRunner = runGit,
): Promise<RepositoryRef> =>
  parseRemoteUrl(await run(['-C', repoPath, 'remote', 'get-url', 'origin']));

export const projectRepoPath = async (
  store: Pick<Store, 'db' | 'projectId'>,
): Promise<string | null> => {
  const { rows } = await store.db.query<{ repoPath: string | null }>(
    'select repo_path as "repoPath" from projects where id = $1',
    [store.projectId],
  );
  return rows[0]?.repoPath ?? null;
};
