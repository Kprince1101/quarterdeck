import type {
  ProfilesView,
  RuleLayer,
  RuleView,
  RulesView,
} from '@quarterdeck/server/intents';
import {
  RULE_SCHEMAS,
  profileManifestSchema,
  type RuleName,
} from '@quarterdeck/rules/schemas';
import { STEERING_FILES } from '@quarterdeck/rules/steering-files';

const SHIPPED_DIR = '../../../../rules';

const SHIPPED = import.meta.glob<string>(
  [
    '../../../../rules/*.md',
    '../../../../rules/*.json',
    '../../../../rules/profiles/default/*',
  ],
  { query: '?raw', import: 'default', eager: true },
);

const DEFAULT_PROFILE_DIR = 'profiles/default';

export const DEMO_HOME = '/home/demo';
export const DEMO_DEFAULTS_DIR = '/demo/quarterdeck/rules';

const RULE_NAMES = Object.keys(RULE_SCHEMAS) as RuleName[];

const MARKDOWN_RULES: ReadonlySet<RuleName> = new Set(['charter', 'reviewer']);

export const ruleFile = (name: RuleName): string => {
  if (MARKDOWN_RULES.has(name)) return `${name}.md`;
  return `${name}.json`;
};

const shippedFile = (file: string): string => {
  const content = SHIPPED[`${SHIPPED_DIR}/${file}`];
  if (content === undefined) throw new Error(`No shipped ${file}`);
  return content;
};

export const shippedRule = (name: RuleName): string =>
  shippedFile(ruleFile(name));

const localPath = (dir: string, name: RuleName): string =>
  `${dir}/.quarterdeck/rules.local.${ruleFile(name)}`;

const repoFile = (repoPath: string | null, file: string): string | null => {
  if (repoPath === null) return null;
  return `${repoPath}/.quarterdeck/rules.local.${file}`;
};

const demoProfiles = (repoPath: string | null): ProfilesView => {
  const manifest = profileManifestSchema.parse(
    JSON.parse(shippedFile(`${DEFAULT_PROFILE_DIR}/profile.json`)),
  );
  const dir = `${DEMO_DEFAULTS_DIR}/${DEFAULT_PROFILE_DIR}`;
  return {
    active: 'default',
    chosenBy: 'shipped',
    levels: {},
    error: null,
    profiles: [
      {
        name: 'default',
        source: 'shipped',
        dir,
        description: manifest.description,
        files: [
          `${dir}/profile.json`,
          ...manifest.standards.map((file) => `${dir}/${file}`),
        ],
        levels: manifest.levels,
        setup: false,
        error: null,
      },
    ],
    steeringFiles: STEERING_FILES.map(({ file, controls }) => ({
      file,
      controls,
      machine: `${DEMO_HOME}/.quarterdeck/rules.local.${file}`,
      repo: repoFile(repoPath, file),
    })),
  };
};

export interface DemoRules {
  view: (project: string | null, repoPath: string | null) => RulesView;
  write: (name: RuleName, content: string) => void;
  reset: (name: RuleName) => void;
  content: (name: RuleName) => string;
}

export const createDemoRules = (
  machine: Partial<Record<RuleName, string>> = {},
): DemoRules => {
  const local = new Map<RuleName, string>(
    Object.entries(machine) as [RuleName, string][],
  );
  const repoLayer = (name: RuleName, repoPath: string | null) => {
    if (repoPath === null) return null;
    const layer: RuleLayer = { path: localPath(repoPath, name), content: null };
    return layer;
  };
  const ruleView = (name: RuleName, repoPath: string | null): RuleView => ({
    name,
    file: ruleFile(name),
    defaults: {
      path: `${DEMO_DEFAULTS_DIR}/${ruleFile(name)}`,
      content: shippedRule(name),
    },
    machine: {
      path: localPath(DEMO_HOME, name),
      content: local.get(name) ?? null,
    },
    repo: repoLayer(name, repoPath),
  });
  return {
    view: (project, repoPath) => {
      const repo = (project !== null && repoPath) || null;
      return {
        project,
        repoPath: repo,
        rules: RULE_NAMES.map((name) => ruleView(name, repo)),
        profiles: demoProfiles(repo),
      };
    },
    write: (name, content) => {
      local.set(name, content);
    },
    reset: (name) => {
      local.delete(name);
    },
    content: (name) => local.get(name) ?? shippedRule(name),
  };
};
