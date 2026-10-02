import type {
  RuleLayer,
  RuleView,
  RulesView,
} from '@quarterdeck/server/intents';
import { RULE_SCHEMAS, type RuleName } from '@quarterdeck/rules/schemas';

const SHIPPED_DIR = '../../../../rules';

const SHIPPED = import.meta.glob<string>(
  ['../../../../rules/*.md', '../../../../rules/*.json'],
  { query: '?raw', import: 'default', eager: true },
);

export const DEMO_HOME = '/home/demo';
export const DEMO_DEFAULTS_DIR = '/demo/quarterdeck/rules';

const RULE_NAMES = Object.keys(RULE_SCHEMAS) as RuleName[];

const MARKDOWN_RULES: ReadonlySet<RuleName> = new Set(['charter', 'reviewer']);

export const ruleFile = (name: RuleName): string => {
  if (MARKDOWN_RULES.has(name)) return `${name}.md`;
  return `${name}.json`;
};

export const shippedRule = (name: RuleName): string => {
  const content = SHIPPED[`${SHIPPED_DIR}/${ruleFile(name)}`];
  if (content === undefined) throw new Error(`No shipped ${ruleFile(name)}`);
  return content;
};

const localPath = (dir: string, name: RuleName): string =>
  `${dir}/.quarterdeck/rules.local.${ruleFile(name)}`;

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
