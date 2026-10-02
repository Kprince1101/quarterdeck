import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES_DIR,
  permissionsSchema,
  shellAllowWarnings,
  type Decision,
  type Permissions,
} from '@quarterdeck/rules';

const HARDENED = resolve(
  DEFAULT_RULES_DIR,
  'examples',
  'hardened.permissions.json',
);

const execute = (
  pattern: string | undefined,
  decision: Decision = 'allow',
): Permissions => ({
  default: 'ask',
  rules: [{ kind: 'execute', decision, ...(pattern && { pattern }) }],
});

const warningFor = (pattern: string | undefined) =>
  shellAllowWarnings(execute(pattern));

describe('shellAllowWarnings', () => {
  it.each([
    ['git *', 'permits git with any arguments, which can run any code.'],
    ['git * *', 'permits git with any arguments, which can run any code.'],
    ['*', 'permits any command.'],
    ['git*', 'permits any command that starts with "git".'],
    ['bash *', 'permits bash, which can run any code.'],
    ['sh -c *', 'permits sh, which can run any code.'],
    ['node scripts/build.js', 'permits node, which can run any code.'],
    ['python3 -m pytest *', 'permits python, which can run any code.'],
    ['/usr/bin/zsh *', 'permits zsh, which can run any code.'],
    ['npx vitest *', 'permits npx, which can run any code.'],
    ['xargs *', 'permits xargs, which can run any code.'],
  ])('flags %s', (pattern, permits) => {
    expect(warningFor(pattern)).toEqual([
      `execute allow "${pattern}" ${permits}`,
    ]);
  });

  it.each(['git status *', 'git status', 'npm test', 'ls', 'git diff --stat'])(
    'leaves %s alone',
    (pattern) => {
      expect(warningFor(pattern)).toEqual([]);
    },
  );

  it('flags an execute allow with no pattern', () => {
    expect(warningFor(undefined)).toEqual([
      'execute allow with no pattern permits any command.',
    ]);
  });

  it('flags a default allow that no execute rule overrides', () => {
    expect(shellAllowWarnings({ default: 'allow', rules: [] })).toEqual([
      'default "allow" permits any command no execute rule names.',
    ]);
    expect(
      shellAllowWarnings({
        default: 'allow',
        rules: [{ kind: 'execute', decision: 'ask' }],
      }),
    ).toEqual([]);
  });

  it.each(['deny', 'ask'] as const)('ignores a broad %s', (decision) => {
    expect(shellAllowWarnings(execute('bash *', decision))).toEqual([]);
  });

  it('ignores rules of other kinds', () => {
    expect(
      shellAllowWarnings({
        default: 'ask',
        rules: [{ kind: 'read', pattern: '*', decision: 'allow' }],
      }),
    ).toEqual([]);
  });
});

describe('the hardened example layer', () => {
  it('is a valid permissions layer with no broad shell allow', async () => {
    const layer = permissionsSchema.parse(
      JSON.parse(await readFile(HARDENED, 'utf8')),
    );

    expect(layer.default).toBe('ask');
    expect(shellAllowWarnings(layer)).toEqual([]);
  });
});
