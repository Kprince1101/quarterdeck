import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { getErrorMessage, isMissingFile, RulesError } from './errors.js';
import { tightenRepoLifecycle } from './budget-layers.js';
import { mergeLayer } from './merge-layer.js';
import {
  RULE_SCHEMAS,
  type Lifecycle,
  type RuleName,
  type Rules,
} from './schemas.js';

export const DEFAULT_RULES_DIR = resolve(import.meta.dirname, '..');
export const LOCAL_RULES_DIR = '.quarterdeck';
export const LOCAL_RULES_PREFIX = 'rules.local.';

export const RULE_FILES: Record<RuleName, string> = {
  charter: 'charter.md',
  reviewer: 'reviewer.md',
  permissions: 'permissions.json',
  naming: 'naming.json',
  lifecycle: 'lifecycle.json',
  models: 'models.json',
};

export const RULE_NAMES = Object.keys(RULE_FILES) as RuleName[];

export const TIGHTEN_ONLY_RULES: ReadonlySet<RuleName> = new Set([
  'permissions',
]);

export interface LoadRulesOptions {
  defaultsDir?: string;
  homeDir?: string;
  repoDir?: string;
}

export interface RuleLayers {
  defaults: string;
  local: string[];
}

export const ruleLayerPaths = (
  name: RuleName,
  options: LoadRulesOptions = {},
): RuleLayers => {
  const file = RULE_FILES[name];
  const localFile = `${LOCAL_RULES_PREFIX}${file}`;
  const localDirs = [options.homeDir ?? homedir()];
  if (options.repoDir) localDirs.push(options.repoDir);
  return {
    defaults: resolve(options.defaultsDir ?? DEFAULT_RULES_DIR, file),
    local: localDirs.map((dir) => resolve(dir, LOCAL_RULES_DIR, localFile)),
  };
};

const mergedLayerOptions = (
  name: RuleName,
  options: LoadRulesOptions,
): LoadRulesOptions => {
  if (!TIGHTEN_ONLY_RULES.has(name)) return options;
  const { repoDir: _repoDir, ...machine } = options;
  return machine;
};

const readDefaults = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new RulesError(path, getErrorMessage(err));
  }
};

export const readLocal = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isMissingFile(err)) return undefined;
    throw new RulesError(path, getErrorMessage(err));
  }
};

export const parseLayer = (path: string, text: string): unknown => {
  if (extname(path) === '.md') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new RulesError(path, getErrorMessage(err));
  }
};

const validateLayer = (name: RuleName, path: string, value: unknown) => {
  const result = RULE_SCHEMAS[name].safeParse(value);
  if (!result.success) {
    throw new RulesError(path, z.prettifyError(result.error));
  }
  return result.data;
};

export const loadRule = async <K extends RuleName>(
  name: K,
  options: LoadRulesOptions = {},
): Promise<Rules[K]> => {
  const layerOptions = mergedLayerOptions(name, options);
  const layers = ruleLayerPaths(name, layerOptions);
  const hasRepoLayer = Boolean(layerOptions.repoDir);
  const defaults = parseLayer(
    layers.defaults,
    await readDefaults(layers.defaults),
  );
  let merged = validateLayer(name, layers.defaults, defaults);
  let machine: typeof merged | undefined;
  for (const [index, path] of layers.local.entries()) {
    const text = await readLocal(path);
    if (text === undefined) continue;
    const layer = parseLayer(path, text);
    if (hasRepoLayer && index === layers.local.length - 1) machine = merged;
    merged = validateLayer(name, path, mergeLayer(merged, layer));
  }
  if (name === 'lifecycle' && machine !== undefined) {
    merged = tightenRepoLifecycle(machine as Lifecycle, merged as Lifecycle);
  }
  return merged as Rules[K];
};

export const loadRules = async (
  options: LoadRulesOptions = {},
): Promise<Rules> => {
  const entries = await Promise.all(
    RULE_NAMES.map(async (name) => [name, await loadRule(name, options)]),
  );
  return Object.fromEntries(entries) as Rules;
};
