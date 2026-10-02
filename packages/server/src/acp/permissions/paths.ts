import { isAbsolute, relative, resolve, sep } from 'node:path';

const toPosix = (path: string): string => path.split(sep).join('/');

const repoRelative = (repoDir: string, path: string): string =>
  relative(resolve(repoDir), resolve(repoDir, path));

export const isInsideRepo = (repoDir: string, path: string): boolean => {
  const rel = repoRelative(repoDir, path);
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
};

export const pathSubject = (repoDir: string, path: string): string => {
  if (!isInsideRepo(repoDir, path)) return toPosix(resolve(repoDir, path));
  return toPosix(repoRelative(repoDir, path)) || '.';
};
