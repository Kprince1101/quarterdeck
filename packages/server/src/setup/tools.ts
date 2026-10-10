import { loadRule, type Runtime } from '@quarterdeck/rules';
import type { ApiContext } from '../api/context.js';
import { HttpError } from '../api/http-error.js';
import type { SetupTool, SetupToolsResult } from '../intents/index.js';
import { detectWorkspace } from '../workspace/index.js';
import { resolveSetupPath } from './paths.js';

const NOT_AVAILABLE = 501;

const installedRuntime = ({ tool, installed }: SetupTool): Runtime[] => {
  if (!installed || tool.kind !== 'runtime') return [];
  return [tool.runtime];
};

export const defaultRuntime = async (
  homeDir: string,
  runtimes: readonly SetupTool[],
): Promise<Runtime | null> => {
  const installed = runtimes.flatMap(installedRuntime);
  const [only, ...others] = installed;
  if (only === undefined) return null;
  if (others.length === 0) return only;
  const { driver } = await loadRule('models', { homeDir });
  if (installed.includes(driver.runtime)) return driver.runtime;
  return null;
};

const repoPathsOf = async (
  ctx: ApiContext,
  root: string | undefined,
): Promise<string[]> => {
  if (root === undefined) return [];
  const detection = await detectWorkspace(resolveSetupPath(root, ctx.homeDir));
  return detection.repositories.map((repo) => repo.repoPath);
};

export const setupTools = async (
  ctx: ApiContext,
  root: string | undefined,
): Promise<SetupToolsResult> => {
  if (ctx.setupProbe === undefined) {
    throw new HttpError(
      NOT_AVAILABLE,
      'Runtime checks run only in a server started by quarterdeck up',
    );
  }
  const tools = await ctx.setupProbe.tools(await repoPathsOf(ctx, root));
  const runtimes = tools.filter(({ tool }) => tool.kind === 'runtime');
  return {
    runtimes,
    forges: tools.filter(({ tool }) => tool.kind !== 'runtime'),
    defaultRuntime: await defaultRuntime(ctx.homeDir, runtimes),
  };
};
