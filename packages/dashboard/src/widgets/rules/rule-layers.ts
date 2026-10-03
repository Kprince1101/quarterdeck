import {
  RulesError,
  isJsonObject,
  mergeLayer,
  mergeRepoKiro,
  mergeRepoLifecycle,
} from '@quarterdeck/rules/merge';
import {
  RULE_SCHEMAS,
  repoPermissionsSchema,
  type Permissions,
  type RuleName,
} from '@quarterdeck/rules/schemas';
import { shellAllowWarnings } from '@quarterdeck/rules/shell-warnings';
import { z } from 'zod';
import type { RuleView } from '../../api/index.js';
import { getErrorMessage } from '../../lib/errors.js';
import {
  EMPTY_JSON_LAYER,
  REPO_ENV_IGNORED,
  REPO_TIGHTEN_ONLY_KEYS,
} from './constants.js';

export type LayerName = 'defaults' | 'machine' | 'repo';

export interface DraftCheck {
  error: string | null;
  layer: unknown;
  merged: unknown;
  effective: unknown;
  repoLayer: unknown;
  repoError: string | null;
}

export interface ValueSource {
  key: string;
  value: string;
  layer: LayerName;
  tightenOnly: boolean;
}

type Path = readonly string[];

type RepoResult = Pick<DraftCheck, 'effective' | 'repoLayer' | 'repoError'>;

export const isMarkdownRule = (rule: RuleView): boolean =>
  rule.file.endsWith('.md');

export const initialDraft = (rule: RuleView): string => {
  if (rule.machine.content !== null) return rule.machine.content;
  if (isMarkdownRule(rule)) return rule.defaults.content;
  return EMPTY_JSON_LAYER;
};

const parseLayer = (rule: RuleView, path: string, text: string): unknown => {
  if (isMarkdownRule(rule)) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new RulesError(path, getErrorMessage(err));
  }
};

const validate = (name: RuleName, path: string, value: unknown): unknown => {
  const result = RULE_SCHEMAS[name].safeParse(value);
  if (!result.success) {
    throw new RulesError(path, z.prettifyError(result.error));
  }
  return result.data;
};

const repoLayerOf = (rule: RuleView, path: string, text: string): unknown => {
  const parsed = parseLayer(rule, path, text);
  if (rule.name === 'env') throw new RulesError(path, REPO_ENV_IGNORED);
  if (rule.name !== 'permissions') return parsed;
  const result = repoPermissionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new RulesError(
      path,
      `the repo layer may only tighten permissions\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
};

const mergeRepo = (
  rule: RuleView,
  merged: unknown,
  layer: unknown,
  path: string,
): unknown => {
  if (rule.name === 'permissions') return merged;
  if (rule.name === 'lifecycle') {
    return validate(rule.name, path, mergeRepoLifecycle(merged, layer, path));
  }
  if (rule.name === 'kiro') {
    return validate(rule.name, path, mergeRepoKiro(merged, layer, path));
  }
  return validate(rule.name, path, mergeLayer(merged, layer));
};

const applyRepo = (rule: RuleView, merged: unknown): RepoResult => {
  const { repo } = rule;
  if (repo === null || repo.content === null) {
    return { effective: merged, repoLayer: undefined, repoError: null };
  }
  try {
    const layer = repoLayerOf(rule, repo.path, repo.content);
    const effective = mergeRepo(rule, merged, layer, repo.path);
    return { effective, repoLayer: layer, repoError: null };
  } catch (err) {
    if (!(err instanceof RulesError)) throw err;
    return { effective: merged, repoLayer: undefined, repoError: err.message };
  }
};

const refused = (err: unknown): DraftCheck => {
  if (!(err instanceof RulesError)) throw err;
  return {
    error: err.message,
    layer: undefined,
    merged: undefined,
    effective: undefined,
    repoLayer: undefined,
    repoError: null,
  };
};

export const checkDraft = (rule: RuleView, draft: string): DraftCheck => {
  try {
    const defaults = validate(
      rule.name,
      rule.defaults.path,
      parseLayer(rule, rule.defaults.path, rule.defaults.content),
    );
    const layer = parseLayer(rule, rule.machine.path, draft);
    const merged = validate(
      rule.name,
      rule.machine.path,
      mergeLayer(defaults, layer),
    );
    return { error: null, layer, merged, ...applyRepo(rule, merged) };
  } catch (err) {
    return refused(err);
  }
};

export const shellWarnings = (rule: RuleView, check: DraftCheck): string[] => {
  if (rule.name !== 'permissions' || check.error !== null) return [];
  return shellAllowWarnings(check.merged as Permissions);
};

const leaves = (value: unknown, path: Path = []): [Path, unknown][] => {
  if (!isJsonObject(value) || Object.keys(value).length === 0) {
    return [[path, value]];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, [...path, key]),
  );
};

const valueAt = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>((node, key) => {
    if (!isJsonObject(node)) return undefined;
    return node[key];
  }, value);

const sets = (layer: unknown, path: Path): boolean => {
  let node = layer;
  for (const key of path) {
    if (!isJsonObject(node) || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
};

export const isTightenOnly = (name: RuleName, path: Path): boolean => {
  if (name === 'permissions') return true;
  const key = path.join('.');
  return (
    REPO_TIGHTEN_ONLY_KEYS[name]?.some(
      (prefix) => key === prefix || key.startsWith(`${prefix}.`),
    ) ?? false
  );
};

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const repoWins = (rule: RuleView, check: DraftCheck, path: Path): boolean => {
  if (rule.name === 'permissions' || !sets(check.repoLayer, path)) {
    return false;
  }
  if (!isTightenOnly(rule.name, path)) return true;
  return !sameValue(
    valueAt(check.effective, path),
    valueAt(check.merged, path),
  );
};

const jsonSource = (
  rule: RuleView,
  check: DraftCheck,
  path: Path,
): LayerName => {
  if (repoWins(rule, check, path)) return 'repo';
  if (sets(check.layer, path)) return 'machine';
  return 'defaults';
};

const markdownSource = (
  rule: RuleView,
  check: DraftCheck,
  draft: string,
): LayerName => {
  if (check.repoLayer !== undefined) return 'repo';
  if (rule.machine.content === null && draft === initialDraft(rule)) {
    return 'defaults';
  }
  return 'machine';
};

export const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

export const valueSources = (
  rule: RuleView,
  check: DraftCheck,
  draft: string,
): ValueSource[] => {
  if (check.error !== null) return [];
  if (isMarkdownRule(rule)) {
    return [
      {
        key: rule.file,
        value: formatValue(check.effective),
        layer: markdownSource(rule, check, draft),
        tightenOnly: false,
      },
    ];
  }
  return leaves(check.effective).map(([path, value]) => ({
    key: path.join('.'),
    value: formatValue(value),
    layer: jsonSource(rule, check, path),
    tightenOnly: isTightenOnly(rule.name, path),
  }));
};
