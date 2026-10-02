import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_RULES_DIR,
  RULE_FILES,
  RULE_NAMES,
  type RuleName,
} from '@quarterdeck/rules';
import type { RuleLayer, RuleView, RulesView } from '../../src/api/index.js';

export const HOME = '/home/me/.quarterdeck';
export const REPO = '/work/deck';

export interface RuleOverrides {
  machine?: string;
  repo?: string;
}

const repoLayer = (
  file: string,
  overrides: RuleOverrides,
  repoDir: string | null,
): RuleLayer | null => {
  if (repoDir === null) return null;
  return {
    path: join(repoDir, '.quarterdeck', `rules.local.${file}`),
    content: overrides.repo ?? null,
  };
};

export const ruleView = (
  name: RuleName,
  overrides: RuleOverrides = {},
  repoDir: string | null = null,
): RuleView => {
  const file = RULE_FILES[name];
  const defaults = join(DEFAULT_RULES_DIR, file);
  return {
    name,
    file,
    defaults: { path: defaults, content: readFileSync(defaults, 'utf8') },
    machine: {
      path: join(HOME, `rules.local.${file}`),
      content: overrides.machine ?? null,
    },
    repo: repoLayer(file, overrides, repoDir),
  };
};

export const rulesView = (
  overrides: Partial<Record<RuleName, RuleOverrides>> = {},
  repoDir: string | null = null,
): RulesView => ({
  project: repoDir && 'deck',
  repoPath: repoDir,
  rules: RULE_NAMES.map((name) => ruleView(name, overrides[name], repoDir)),
});
