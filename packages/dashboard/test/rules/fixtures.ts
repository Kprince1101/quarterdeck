import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_RULES_DIR,
  RULE_FILES,
  RULE_NAMES,
  type RuleName,
} from '@quarterdeck/rules';
import type {
  ProfilesView,
  RuleLayer,
  RuleView,
  RulesView,
} from '../../src/api/index.js';

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

export const HOUSE_DIR = join(HOME, 'profiles', 'house');

const activeProfile = (overrides: RuleOverrides = {}): string => {
  if (overrides.machine === undefined) return 'default';
  const layer = JSON.parse(overrides.machine) as { profile?: string };
  return layer.profile ?? 'default';
};

export const profilesView = (overrides: RuleOverrides = {}): ProfilesView => {
  const active = activeProfile(overrides);
  return {
    active,
    chosenBy: (active === 'default' && 'shipped') || 'machine',
    levels: {},
    error: null,
    profiles: [
      {
        name: 'default',
        source: 'shipped',
        dir: join(DEFAULT_RULES_DIR, 'profiles', 'default'),
        description: 'Generic and language-neutral.',
        files: [join(DEFAULT_RULES_DIR, 'profiles', 'default', 'profile.json')],
        levels: {},
        setup: false,
        error: null,
      },
      {
        name: 'house',
        source: 'machine',
        dir: HOUSE_DIR,
        description: 'The house style.',
        files: [join(HOUSE_DIR, 'profile.json'), '/docs/house-standards.md'],
        levels: { 'no-ternary': 3, 'max-lines': 2 },
        setup: true,
        error: null,
      },
    ],
    steeringFiles: [],
  };
};

export const rulesView = (
  overrides: Partial<Record<RuleName, RuleOverrides>> = {},
  repoDir: string | null = null,
): RulesView => ({
  project: repoDir && 'deck',
  repoPath: repoDir,
  rules: RULE_NAMES.map((name) => ruleView(name, overrides[name], repoDir)),
  profiles: profilesView(overrides.profile),
});
