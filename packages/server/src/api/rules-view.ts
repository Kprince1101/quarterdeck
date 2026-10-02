import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import {
  RULE_FILES,
  RULE_NAMES,
  ruleLayerPaths,
  type RuleName,
} from '@quarterdeck/rules';
import {
  RULES_PROJECT_PARAM,
  projectSlugSchema,
  type RuleLayer,
  type RuleView,
  type RulesView,
} from '../intents/index.js';
import { hasErrorCode } from '../lib/errors.js';
import type { ApiContext } from './context.js';
import { HttpError, badRequest } from './http-error.js';
import { findRow } from './record.js';
import { ruleLayerPath } from './rule-files.js';

const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return null;
    throw err;
  }
};

const layerAt = async (path: string): Promise<RuleLayer> => ({
  path,
  content: await readIfPresent(path),
});

const repoLayer = async (
  name: RuleName,
  homeDir: string,
  repoDir: string | null,
): Promise<RuleLayer | null> => {
  if (repoDir === null) return null;
  return layerAt(ruleLayerPath({ name, homeDir, repoDir }));
};

const ruleView = async (
  name: RuleName,
  homeDir: string,
  repoDir: string | null,
): Promise<RuleView> => {
  const defaults = ruleLayerPaths(name, { homeDir }).defaults;
  return {
    name,
    file: RULE_FILES[name],
    defaults: { path: defaults, content: await readFile(defaults, 'utf8') },
    machine: await layerAt(ruleLayerPath({ name, homeDir })),
    repo: await repoLayer(name, homeDir, repoDir),
  };
};

const projectRepoPath = async (
  ctx: ApiContext,
  project: string | null,
): Promise<string | null> => {
  if (project === null) return null;
  const store = await ctx.stores.get(project);
  const row = await findRow<{ repo_path: string | null }>(
    store.db,
    'select repo_path from projects where id = $1',
    [store.projectId],
    `project ${project} not found`,
  );
  return row.repo_path;
};

const projectParam = (req: IncomingMessage): string | null => {
  const { searchParams } = new URL(req.url ?? '/', 'http://localhost');
  const project = searchParams.get(RULES_PROJECT_PARAM);
  if (project === null) return null;
  if (!projectSlugSchema.safeParse(project).success) {
    throw badRequest(`${project} is not a project slug`);
  }
  return project;
};

export const readRulesView = async (
  ctx: ApiContext,
  project: string | null,
): Promise<RulesView> => {
  const repoPath = await projectRepoPath(ctx, project);
  const rules = await Promise.all(
    RULE_NAMES.map((name) => ruleView(name, ctx.homeDir, repoPath)),
  );
  return { project, repoPath, rules };
};

export const routeRulesView = async (
  ctx: ApiContext,
  req: IncomingMessage,
): Promise<RulesView> => {
  if (req.method !== 'GET') {
    throw new HttpError(405, 'Rules are read with GET', {
      headers: { allow: 'GET' },
    });
  }
  return readRulesView(ctx, projectParam(req));
};
