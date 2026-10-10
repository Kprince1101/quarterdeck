import { readFile } from 'node:fs/promises';
import {
  modelsSchema,
  ruleLayerPaths,
  type Models,
  type Runtime,
} from '@quarterdeck/rules';
import type { ApiContext } from '../api/context.js';
import { dispatchIntent } from '../api/dispatch.js';
import { badRequest } from '../api/http-error.js';
import { INTENTS, type IntentPayload } from '../intents/index.js';
import { pathExists } from '../lib/fs.js';

const ROLES = Object.keys(modelsSchema.shape) as Array<keyof Models>;

export interface RuntimeLayer {
  path: string;
  inRepo: boolean;
}

export interface RuntimeChoice {
  runtime: Runtime;
  layer: RuntimeLayer | undefined;
}

export interface ModelsLayers {
  machine: string;
  repo: string;
}

export const modelsLayers = (
  homeDir: string,
  repoDir: string,
): ModelsLayers => {
  const [machine, repo] = ruleLayerPaths('models', { homeDir, repoDir }).local;
  if (machine === undefined || repo === undefined) {
    throw new Error('models has no local rule layers');
  }
  return { machine, repo };
};

export const repoRuntimeLayer = async (
  homeDir: string,
  repoDir: string,
): Promise<string | undefined> => {
  const { repo } = modelsLayers(homeDir, repoDir);
  if (await pathExists(repo)) return repo;
  return undefined;
};

export const usesRuntime = (models: Models, runtime: Runtime): boolean =>
  ROLES.every((role) => models[role].runtime === runtime);

export const readJsonLayer = async (
  path: string,
): Promise<Record<string, unknown>> => {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    throw badRequest(`${path} is not valid JSON`);
  }
  throw badRequest(`${path} is not a JSON object`);
};

const withRuntime = (
  layer: Record<string, unknown>,
  runtime: Runtime,
): Record<string, unknown> => {
  const roles = ROLES.map((role) => {
    const current = layer[role];
    const kept = typeof current === 'object' && current !== null && current;
    return [role, { ...kept, runtime }];
  });
  return { ...layer, ...Object.fromEntries(roles) };
};

const ruleWrite = (
  project: string,
  layer: RuntimeLayer,
  content: string,
): IntentPayload<'rules.write'> => {
  if (layer.inRepo) {
    return INTENTS['rules.write'].parse({
      scope: 'project',
      project,
      name: 'models',
      content,
    });
  }
  return INTENTS['rules.write'].parse({
    scope: 'machine',
    name: 'models',
    content,
  });
};

export const saveRuntime = async (
  ctx: Pick<ApiContext, 'stores' | 'homeDir'>,
  project: string,
  runtime: Runtime,
  layer: RuntimeLayer,
): Promise<void> => {
  const models = withRuntime(await readJsonLayer(layer.path), runtime);
  const content = `${JSON.stringify(models, null, 2)}\n`;
  await dispatchIntent(
    { stores: ctx.stores, homeDir: ctx.homeDir },
    'rules.write',
    ruleWrite(project, layer, content),
  );
};
