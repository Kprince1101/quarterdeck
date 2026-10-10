import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { childEnv, wholeEnv } from '../env.js';

const OPENERS: Partial<Record<NodeJS.Platform, (url: string) => string[]>> = {
  darwin: (url) => ['open', url],
  win32: (url) => ['rundll32', 'url.dll,FileProtocolHandler', url],
};

const opener = (platform: NodeJS.Platform, url: string): string[] =>
  OPENERS[platform]?.(url) ?? ['xdg-open', url];

export const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

export const openInBrowser = async (
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> => {
  if (!isWebUrl(url)) throw new Error(`refusing to open ${url}`);
  const [command = 'xdg-open', ...args] = opener(platform, url);
  const child = spawn(command, args, {
    env: childEnv(wholeEnv()),
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
  await once(child, 'spawn');
};
