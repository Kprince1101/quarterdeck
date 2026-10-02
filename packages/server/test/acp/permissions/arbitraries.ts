import { resolve } from 'node:path';
import fc from 'fast-check';
import {
  decisionSchema,
  tighteningDecisionSchema,
  toolKindSchema,
} from '@quarterdeck/rules';
import type {
  Decision,
  PermissionLayers,
  PermissionRule,
  Permissions,
  RepoPermissions,
  TighteningRule,
  ToolKind,
} from '@quarterdeck/rules';
import type { ToolRequest } from '@quarterdeck/server';

export const REPO_DIR = resolve('/work/repo');

export const SAFE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-_.';

export const OUTSIDE_PATHS = [
  resolve('/etc/passwd'),
  resolve('/work/other/file.ts'),
  resolve('/work/repo-sibling/x.ts'),
  resolve('/'),
];

export const INSIDE_PATHS = [
  resolve(REPO_DIR, 'src/index.ts'),
  resolve(REPO_DIR, 'src/deep/nested/file.ts'),
  resolve(REPO_DIR, '.env'),
  resolve(REPO_DIR, 'README.md'),
  REPO_DIR,
];

export const UNPINNED_COMMANDS = [
  'npm test; rm -rf /',
  'npm run build && npm test',
  'cat /etc/passwd',
  'ls ../..',
  'echo $HOME',
  'cat ~/.ssh/id_rsa',
  'git log | head',
  'npm test > out.txt',
  'echo `whoami`',
  'node --config=/etc/x',
];

export const PINNED_COMMANDS = [
  'npm test',
  'npm run validate',
  'git status',
  'rm -rf src/generated',
  'cat src/index.ts',
  'ls',
];

export const PATTERNS = [
  '**',
  'src/**',
  '**/*.ts',
  'src/*',
  '*.md',
  '.env',
  '/etc/**',
  'npm test',
  'npm *',
  'rm *',
  'git *',
  'cat *',
  'https://example.com/**',
];

export const OUTSIDE_CWDS = [resolve('/tmp'), resolve('/work')];
const INSIDE_CWDS = [REPO_DIR, resolve(REPO_DIR, 'src')];

export const toolKindArb: fc.Arbitrary<ToolKind> = fc.constantFrom(
  ...toolKindSchema.options,
);
export const decisionArb: fc.Arbitrary<Decision> = fc.constantFrom(
  ...decisionSchema.options,
);
const tighteningArb = fc.constantFrom(...tighteningDecisionSchema.options);

const patternArb = fc.option(
  fc.oneof(fc.constantFrom(...PATTERNS), fc.string({ minLength: 1 })),
  { nil: undefined },
);

const withPattern = <T extends { pattern?: string | undefined }>(
  rule: T,
  pattern: string | undefined,
): T => {
  if (pattern === undefined) return rule;
  return { ...rule, pattern };
};

export const ruleArb: fc.Arbitrary<PermissionRule> = fc
  .tuple(toolKindArb, patternArb, decisionArb)
  .map(([kind, pattern, decision]) =>
    withPattern<PermissionRule>({ kind, decision }, pattern),
  );

const tighteningRuleArb: fc.Arbitrary<TighteningRule> = fc
  .tuple(toolKindArb, patternArb, tighteningArb)
  .map(([kind, pattern, decision]) =>
    withPattern<TighteningRule>({ kind, decision }, pattern),
  );

export const machineArb: fc.Arbitrary<Permissions> = fc.record({
  default: decisionArb,
  rules: fc.array(ruleArb, { maxLength: 8 }),
});

export const repoArb: fc.Arbitrary<RepoPermissions> = fc.record(
  {
    default: tighteningArb,
    rules: fc.array(tighteningRuleArb, { maxLength: 8 }),
  },
  { requiredKeys: [] },
);

export const layersArb: fc.Arbitrary<PermissionLayers> = fc
  .tuple(machineArb, fc.option(repoArb, { nil: undefined }))
  .map(([machine, repo]) => {
    if (repo === undefined) return { machine };
    return { machine, repo };
  });

const pathArb = fc.oneof(
  fc.constantFrom(...INSIDE_PATHS, ...OUTSIDE_PATHS),
  fc
    .array(fc.string({ unit: fc.constantFrom(...SAFE_CHARS), minLength: 1 }), {
      minLength: 1,
      maxLength: 4,
    })
    .map((segments) => resolve(REPO_DIR, ...segments)),
);

const commandArb = fc.option(
  fc.oneof(
    fc.constantFrom(...PINNED_COMMANDS, ...UNPINNED_COMMANDS),
    fc.string(),
  ),
  { nil: undefined },
);

const urlArb = fc.option(
  fc.constantFrom('https://example.com/docs', 'https://evil.test/x'),
  { nil: undefined },
);

const withOptional = (
  request: ToolRequest,
  command: string | undefined,
  url: string | undefined,
): ToolRequest => {
  const built = { ...request };
  if (command !== undefined) built.command = command;
  if (url !== undefined) built.url = url;
  return built;
};

export const requestArb = (
  kind: fc.Arbitrary<ToolKind> = toolKindArb,
): fc.Arbitrary<ToolRequest> =>
  fc
    .tuple(
      kind,
      fc.constantFrom(...INSIDE_CWDS, ...OUTSIDE_CWDS),
      fc.uniqueArray(pathArb, { maxLength: 3 }),
      commandArb,
      urlArb,
    )
    .map(([toolKind, cwd, paths, command, url]) =>
      withOptional({ kind: toolKind, cwd, paths }, command, url),
    );

export const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
