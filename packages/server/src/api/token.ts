import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { readTextIfExists } from '../lib/fs.js';
import { quarterdeckHome } from '../store/index.js';

export const API_TOKEN_FILE = 'api.token';

export const API_TOKEN_BYTES = 32;

const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;

export const apiTokenPath = (home: string = quarterdeckHome()): string =>
  join(home, API_TOKEN_FILE);

export const createApiToken = (): string =>
  randomBytes(API_TOKEN_BYTES).toString('base64url');

export const writeApiToken = async (
  token: string,
  home: string = quarterdeckHome(),
): Promise<string> => {
  const path = apiTokenPath(home);
  await mkdir(home, { recursive: true });
  await rm(path, { force: true });
  await writeFile(path, token, { mode: 0o600, flag: 'wx' });
  return path;
};

export const readApiToken = async (
  home: string = quarterdeckHome(),
): Promise<string> => (await readFile(apiTokenPath(home), 'utf8')).trim();

export const removeApiToken = async (
  token: string,
  home: string = quarterdeckHome(),
): Promise<void> => {
  const path = apiTokenPath(home);
  if ((await readTextIfExists(path))?.trim() !== token) return;
  await rm(path, { force: true });
};

const digest = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

export const verifyApiToken = (
  token: string,
  presented: string | undefined,
): boolean =>
  presented !== undefined && timingSafeEqual(digest(token), digest(presented));

export const bearerToken = (headers: IncomingHttpHeaders): string | undefined =>
  BEARER.exec(headers.authorization ?? '')?.[1];
