import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { KeepAwakeBackend } from './backend.js';
import { LINUX_BACKEND } from './linux.js';
import { MACOS_BACKEND } from './macos.js';
import { WINDOWS_BACKEND } from './windows.js';

export const KEEP_AWAKE_BACKENDS: Partial<
  Record<NodeJS.Platform, KeepAwakeBackend>
> = {
  darwin: MACOS_BACKEND,
  win32: WINDOWS_BACKEND,
  linux: LINUX_BACKEND,
};

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface ToolLookup {
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export type KeepAwakeSupport =
  | { available: true; tool: string; path: string }
  | { available: false; tool: string | null; reason: string };

const envValue = (env: NodeJS.ProcessEnv, name: string): string => {
  const key = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === name,
  );
  return env[key ?? name] ?? '';
};

const pathFor = (platform: NodeJS.Platform): typeof posix => {
  if (platform === 'win32') return win32;
  return posix;
};

const candidates = (
  tool: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] => {
  const path = pathFor(platform);
  const dirs = envValue(env, 'PATH')
    .split(path.delimiter)
    .filter((dir) => dir !== '');
  if (platform !== 'win32') return dirs.map((dir) => path.join(dir, tool));
  const extensions = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';')
    .filter((extension) => extension !== '');
  return dirs.flatMap((dir) =>
    extensions.map((extension) => path.join(dir, `${tool}${extension}`)),
  );
};

const isExecutable = (file: string): Promise<boolean> =>
  access(file, constants.X_OK).then(
    () => true,
    () => false,
  );

export const findTool = async (
  tool: string,
  lookup: ToolLookup = {},
): Promise<string | null> => {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  for (const file of candidates(tool, platform, env)) {
    if (await isExecutable(file)) return file;
  }
  return null;
};

export const keepAwakeSupport = async (
  lookup: ToolLookup = {},
): Promise<KeepAwakeSupport> => {
  const platform = lookup.platform ?? process.platform;
  const backend = KEEP_AWAKE_BACKENDS[platform];
  if (backend === undefined) {
    return {
      available: false,
      tool: null,
      reason: `Keep-awake is not supported on ${platform}.`,
    };
  }
  const path = await findTool(backend.tool, { ...lookup, platform });
  if (path === null) {
    return {
      available: false,
      tool: backend.tool,
      reason: `${backend.tool} is not on PATH, so Quarterdeck cannot keep this computer awake.`,
    };
  }
  return { available: true, tool: backend.tool, path };
};
