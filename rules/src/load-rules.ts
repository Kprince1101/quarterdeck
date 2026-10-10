import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { getErrorMessage, isMissingFile, RulesError } from './errors.js';
import { FORGES_FILE, refuseRepoForges } from './forges.js';
import { mergeRepoKiro } from './kiro-layer.js';
import {
  mergeRepoLifecycle,
  upgradeLifecycleLayer,
  type UpgradedLayer,
} from './lifecycle-layer.js';
import { isJsonObject, mergeLayer } from './merge-layer.js';
import { locateProfile, type ProfileLocation } from './profile-files.js';
import {
  DEFAULT_RULES_DIR,
  LOCAL_RULES_DIR,
  LOCAL_RULES_PREFIX,
} from './rule-dirs.js';
import { SERVICES_FILE, refuseRepoServices } from './services.js';
import {
  RULE_SCHEMAS,
  type RuleLevels,
  type RuleName,
  type Rules,
} from './schemas.js';

export { DEFAULT_RULES_DIR, LOCAL_RULES_DIR, LOCAL_RULES_PREFIX };

export const RULE_FILES: Record<RuleName, string> = {
  charter: 'charter.md',
  reviewer: 'reviewer.md',
  permissions: 'permissions.json',
  naming: 'naming.json',
  lifecycle: 'lifecycle.json',
  models: 'models.json',
  env: 'env.json',
  kiro: 'kiro.json',
  forges: FORGES_FILE,
  services: SERVICES_FILE,
  profile: 'profile.json',
};

export const RULE_NAMES = Object.keys(RULE_FILES) as RuleName[];

export const TIGHTEN_ONLY_RULES: ReadonlySet<RuleName> = new Set([
  'permissions',
  'env',
]);

export interface LoadRulesOptions {
  defaultsDir?: string;
  homeDir?: string;
  repoDir?: string;
  onWarning?: (warning: string) => void;
}

const warned = new Set<string>();

export const warnOnce = (warning: string): void => {
  if (warned.has(warning)) return;
  warned.add(warning);
  console.warn(`quarterdeck rules: ${warning}`);
};

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

type RepoLayerMerge = (
  merged: unknown,
  layer: unknown,
  path: string,
) => unknown;

const REPO_LAYER_MERGES: Partial<Record<RuleName, RepoLayerMerge>> = {
  lifecycle: mergeRepoLifecycle,
  kiro: mergeRepoKiro,
  forges: refuseRepoForges,
  services: refuseRepoServices,
};

type LayerUpgrade = (layer: unknown, path: string) => UpgradedLayer;

const LAYER_UPGRADES: Partial<Record<RuleName, LayerUpgrade>> = {
  lifecycle: upgradeLifecycleLayer,
};

export const upgradeLayer = (
  name: RuleName,
  layer: unknown,
  path: string,
): UpgradedLayer =>
  LAYER_UPGRADES[name]?.(layer, path) ?? { layer, warnings: [] };

const mergeLocal = (
  name: RuleName,
  merged: unknown,
  layer: unknown,
  path: string,
  isRepoLayer: boolean,
): unknown => {
  const repoMerge = REPO_LAYER_MERGES[name];
  if (isRepoLayer && repoMerge) return repoMerge(merged, layer, path);
  return mergeLayer(merged, layer);
};

export type ProfileChoice = 'shipped' | 'machine' | 'project';

export interface ActiveProfile extends ProfileLocation {
  chosenBy: ProfileChoice;
  levels: RuleLevels;
  repoLevels: RuleLevels;
}

const PROFILE_LAYER_RULES: ReadonlySet<RuleName> = new Set([
  'charter',
  'reviewer',
  'lifecycle',
]);

const layerSetsProfile = async (path: string | undefined) => {
  if (path === undefined) return false;
  const text = await readLocal(path);
  if (text === undefined) return false;
  const layer = parseLayer(path, text);
  return isJsonObject(layer) && Object.hasOwn(layer, 'profile');
};

const profileChoice = async (
  options: LoadRulesOptions,
): Promise<ProfileChoice> => {
  const [machine, repo] = ruleLayerPaths('profile', options).local;
  if (await layerSetsProfile(repo)) return 'project';
  if (await layerSetsProfile(machine)) return 'machine';
  return 'shipped';
};

const levelsSetBy = (merged: RuleLevels, below: RuleLevels): RuleLevels =>
  Object.fromEntries(
    Object.entries(merged).filter(([rule, level]) => below[rule] !== level),
  );

export const activeProfile = async (
  options: LoadRulesOptions = {},
): Promise<ActiveProfile> => {
  const { repoDir: _repoDir, ...machineOptions } = options;
  const [rule, machine] = await Promise.all([
    loadRule('profile', options),
    loadRule('profile', machineOptions),
  ]);
  const location = await locateProfile(rule.profile, options);
  return {
    ...location,
    chosenBy: await profileChoice(options),
    levels: machine.levels,
    repoLevels: levelsSetBy(rule.levels, machine.levels),
  };
};

const appendMarkdown = (base: string, layer: string): string =>
  `${base.trimEnd()}\n\n${layer.trim()}\n`;

const mergeProfileLayer = (
  name: RuleName,
  merged: unknown,
  layer: unknown,
  path: string,
  profile: ActiveProfile,
): unknown => {
  if (typeof merged === 'string' && typeof layer === 'string')
    return appendMarkdown(merged, layer);
  return mergeLocal(name, merged, layer, path, profile.chosenBy === 'project');
};

const withProfileLayer = async (
  name: RuleName,
  merged: unknown,
  options: LoadRulesOptions,
): Promise<unknown> => {
  if (!PROFILE_LAYER_RULES.has(name)) return merged;
  const profile = await activeProfile(options);
  const path = resolve(profile.dir, RULE_FILES[name]);
  const text = await readLocal(path);
  if (text === undefined) return merged;
  const { layer, warnings } = upgradeLayer(name, parseLayer(path, text), path);
  for (const warning of warnings) (options.onWarning ?? warnOnce)(warning);
  const next = mergeProfileLayer(name, merged, layer, path, profile);
  return validateLayer(name, path, next);
};

export const loadRule = async <K extends RuleName>(
  name: K,
  options: LoadRulesOptions = {},
): Promise<Rules[K]> => {
  const layerOptions = mergedLayerOptions(name, options);
  const layers = ruleLayerPaths(name, layerOptions);
  const repoLayer = layerOptions.repoDir && layers.local.at(-1);
  const defaults = parseLayer(
    layers.defaults,
    await readDefaults(layers.defaults),
  );
  let merged = await withProfileLayer(
    name,
    validateLayer(name, layers.defaults, defaults),
    layerOptions,
  );
  const warn = options.onWarning ?? warnOnce;
  for (const path of layers.local) {
    const text = await readLocal(path);
    if (text === undefined) continue;
    const { layer, warnings } = upgradeLayer(
      name,
      parseLayer(path, text),
      path,
    );
    for (const warning of warnings) warn(warning);
    const next = mergeLocal(name, merged, layer, path, path === repoLayer);
    merged = validateLayer(name, path, next);
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
