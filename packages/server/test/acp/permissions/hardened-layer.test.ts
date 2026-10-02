import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES_DIR,
  loadPermissionLayers,
  type PermissionLayers,
} from '@quarterdeck/rules';
import { decidePermission, type ToolRequest } from '@quarterdeck/server';
import { REPO_DIR } from './arbitraries.ts';

const HARDENED = join(
  DEFAULT_RULES_DIR,
  'examples',
  'hardened.permissions.json',
);

const execute = (command: string): ToolRequest => ({
  kind: 'execute',
  cwd: REPO_DIR,
  paths: [],
  command,
});

describe('the hardened example layer', () => {
  let homeDir = '';
  let layers: PermissionLayers;

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-hardened-'));
    await mkdir(join(homeDir, '.quarterdeck'));
    await copyFile(
      HARDENED,
      join(homeDir, '.quarterdeck', 'rules.local.permissions.json'),
    );
    layers = await loadPermissionLayers({ homeDir });
  });

  afterAll(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it.each([
    'git status',
    'git status --short',
    'git diff',
    'git diff --stat HEAD~1',
    'git log --oneline -5',
    'git show HEAD',
    'git rev-parse HEAD',
    'git branch --show-current',
    'ls',
    'pwd',
  ])('allows %s', (command) => {
    expect(decidePermission(layers, execute(command), REPO_DIR)).toBe('allow');
  });

  it.each([
    'git -c x=y push',
    "git -c alias.x='!sh' x",
    'git -c core.pager=less status',
    'git --config-env=core.pager=PAGER log',
  ])('denies %s', (command) => {
    expect(decidePermission(layers, execute(command), REPO_DIR)).toBe('deny');
  });

  it.each([
    'git push',
    'git commit -m wip',
    'git branch -D main',
    'git diff --output=src/index.ts',
    'git log -p --output=notes.txt',
    'git diff --ext-diff',
    'git show --textconv HEAD:README.md',
    'ls -la src',
    'bash -c ls',
    'npm test',
  ])('asks before %s', (command) => {
    expect(decidePermission(layers, execute(command), REPO_DIR)).toBe('ask');
  });

  it('allows the bus tools, which carry no kind or path', () => {
    const busTool: ToolRequest = { kind: 'other', cwd: REPO_DIR, paths: [] };
    expect(decidePermission(layers, busTool, REPO_DIR)).toBe('allow');
  });

  it('asks before any edit', () => {
    const edit: ToolRequest = {
      kind: 'edit',
      cwd: REPO_DIR,
      paths: [join(REPO_DIR, 'src', 'index.ts')],
    };
    expect(decidePermission(layers, edit, REPO_DIR)).toBe('ask');
  });
});
