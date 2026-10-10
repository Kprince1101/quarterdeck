import { forgeOfHost, loadRule } from '@quarterdeck/rules';
import {
  parseRemoteUrl,
  runCommand,
  type SignInTool,
} from '@quarterdeck/server';
import type { CliIo } from './io.js';

const GIT_TIMEOUT_MS = 10_000;

export const originForge = async (
  io: CliIo,
  repoPath: string,
): Promise<SignInTool | undefined> => {
  const origin = await runCommand(
    { command: 'git', args: ['-C', repoPath, 'remote', 'get-url', 'origin'] },
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (origin.status !== 'exited' || origin.code !== 0) return undefined;
  try {
    const host = parseRemoteUrl(origin.stdout).hostname;
    const { forges } = await loadRule('forges', { homeDir: io.homeDir });
    if (forgeOfHost(host, forges) === 'gitlab') return { kind: 'glab', host };
    return { kind: 'gh' };
  } catch {
    return undefined;
  }
};

export const sameTool = (a: SignInTool, b: SignInTool): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export type RepoForge = SignInTool | undefined;

export const repoForges = (
  io: CliIo,
  repoPaths: readonly string[],
): Promise<RepoForge[]> =>
  Promise.all(repoPaths.map((repoPath) => originForge(io, repoPath)));

export const uniqueForges = (forges: readonly RepoForge[]): SignInTool[] => {
  const unique: SignInTool[] = [];
  for (const forge of forges) {
    if (forge && !unique.some((known) => sameTool(known, forge))) {
      unique.push(forge);
    }
  }
  return unique;
};

export const forgeCheckFolder = (
  repoPaths: readonly string[],
  forges: readonly RepoForge[],
): string | undefined => {
  const gitlab = forges.findIndex((forge) => forge?.kind === 'glab');
  return repoPaths[Math.max(gitlab, 0)];
};
