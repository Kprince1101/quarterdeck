import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { getErrorMessage, isMissingFile, RulesError } from './errors.js';
import { DEFAULT_RULES_DIR, LOCAL_RULES_DIR } from './rule-dirs.js';
import { profileManifestSchema, type ProfileManifest } from './schemas.js';

export const PROFILES_DIR = 'profiles';
export const PROFILE_MANIFEST = 'profile.json';
export const DEFAULT_PROFILE = 'default';

export type ProfileSource = 'shipped' | 'machine';

export interface ProfileLocation {
  name: string;
  dir: string;
  source: ProfileSource;
}

export interface ProfileRootOptions {
  defaultsDir?: string | undefined;
  homeDir?: string | undefined;
}

export const shippedProfilesDir = (defaultsDir?: string): string =>
  resolve(defaultsDir ?? DEFAULT_RULES_DIR, PROFILES_DIR);

export const machineProfilesDir = (homeDir?: string): string =>
  resolve(homeDir ?? homedir(), LOCAL_RULES_DIR, PROFILES_DIR);

const profileRoots = (
  options: ProfileRootOptions,
): Array<[ProfileSource, string]> => [
  ['shipped', shippedProfilesDir(options.defaultsDir)],
  ['machine', machineProfilesDir(options.homeDir)],
];

const hasManifest = (dir: string): Promise<boolean> =>
  stat(resolve(dir, PROFILE_MANIFEST)).then(
    (info) => info.isFile(),
    () => false,
  );

export const locateProfile = async (
  name: string,
  options: ProfileRootOptions = {},
): Promise<ProfileLocation> => {
  for (const [source, root] of profileRoots(options)) {
    const dir = resolve(root, name);
    if (await hasManifest(dir)) return { name, dir, source };
  }
  const machine = resolve(machineProfilesDir(options.homeDir), name);
  throw new RulesError(
    resolve(machine, PROFILE_MANIFEST),
    `no profile named ${name}; add one with \`quarterdeck profile add ${name}\` or pick another in rules.local.profile.json`,
  );
};

const namesIn = async (root: string): Promise<string[]> => {
  try {
    return (await readdir(root)).toSorted();
  } catch (err) {
    if (isMissingFile(err)) return [];
    throw new RulesError(root, getErrorMessage(err));
  }
};

export const listProfiles = async (
  options: ProfileRootOptions = {},
): Promise<ProfileLocation[]> => {
  const found = new Map<string, ProfileLocation>();
  for (const [source, root] of profileRoots(options)) {
    for (const name of await namesIn(root)) {
      const dir = resolve(root, name);
      if (!found.has(name) && (await hasManifest(dir)))
        found.set(name, { name, dir, source });
    }
  }
  return [...found.values()];
};

export const profilePath = (
  location: ProfileLocation,
  path: string,
): string => {
  if (isAbsolute(path)) return path;
  return resolve(location.dir, path);
};

export const readProfileManifest = async (
  location: ProfileLocation,
): Promise<ProfileManifest> => {
  const path = resolve(location.dir, PROFILE_MANIFEST);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (err) {
    throw new RulesError(path, getErrorMessage(err));
  }
  const result = profileManifestSchema.safeParse(value);
  if (!result.success)
    throw new RulesError(path, z.prettifyError(result.error));
  return result.data;
};
