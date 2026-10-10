import { isAbsolute, join, resolve } from 'node:path';
import type { ApiContext } from '../api/context.js';
import { badRequest } from '../api/http-error.js';
import { createWorkspaces, type Workspaces } from '../workspace/index.js';

const HOME_PREFIX = '~/';

const expandHome = (path: string, homeDir: string): string => {
  if (path === '~') return homeDir;
  if (path.startsWith(HOME_PREFIX)) {
    return join(homeDir, path.slice(HOME_PREFIX.length));
  }
  return path;
};

export const resolveSetupPath = (path: string, homeDir: string): string => {
  const expanded = expandHome(path, homeDir);
  if (!isAbsolute(expanded)) {
    throw badRequest(
      `Type the folder's full path, such as ${join(homeDir, 'code', 'my-app')}`,
    );
  }
  return resolve(expanded);
};

export const setupWorkspaces = (ctx: ApiContext): Workspaces =>
  ctx.workspaces ?? createWorkspaces(ctx.stores.dataHome);

export const needsSetup = async (ctx: ApiContext): Promise<boolean> => {
  const workspace = await setupWorkspaces(ctx).read();
  if ((workspace?.projects.length ?? 0) > 0) return false;
  const projects = await ctx.stores.list();
  return projects.length === 0;
};
