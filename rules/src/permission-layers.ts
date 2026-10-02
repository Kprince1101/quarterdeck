import { resolve } from 'node:path';
import { z } from 'zod';
import { RulesError } from './errors.js';
import {
  LOCAL_RULES_DIR,
  LOCAL_RULES_PREFIX,
  RULE_FILES,
  loadRule,
  parseLayer,
  readLocal,
  type LoadRulesOptions,
} from './load-rules.js';
import {
  repoPermissionsSchema,
  type Permissions,
  type RepoPermissions,
} from './schemas.js';

export interface PermissionLayers {
  machine: Permissions;
  repo?: RepoPermissions;
}

export const repoPermissionsPath = (repoDir: string): string =>
  resolve(
    repoDir,
    LOCAL_RULES_DIR,
    `${LOCAL_RULES_PREFIX}${RULE_FILES.permissions}`,
  );

export const loadRepoPermissions = async (
  repoDir: string,
): Promise<RepoPermissions | undefined> => {
  const path = repoPermissionsPath(repoDir);
  const text = await readLocal(path);
  if (text === undefined) return undefined;
  const result = repoPermissionsSchema.safeParse(parseLayer(path, text));
  if (!result.success) {
    throw new RulesError(
      path,
      `the repo layer may only tighten permissions\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
};

export const loadPermissionLayers = async (
  options: LoadRulesOptions = {},
): Promise<PermissionLayers> => {
  const machine = await loadRule('permissions', options);
  if (!options.repoDir) return { machine };
  const repo = await loadRepoPermissions(options.repoDir);
  if (!repo) return { machine };
  return { machine, repo };
};
