import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  PermissionOption,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Decision,
  PermissionLayers,
  Permissions,
} from '@quarterdeck/rules';
import { canonicalPath, createPermissionPolicy } from '@quarterdeck/server';

interface Sandbox {
  root: string;
  repo: string;
  outside: string;
  repoLink: string;
}

const OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Once', kind: 'allow_once' },
  { optionId: 'no', name: 'Not now', kind: 'reject_once' },
];

const MACHINE: Permissions = {
  default: 'deny',
  rules: [
    { kind: 'read', decision: 'allow' },
    { kind: 'search', decision: 'allow' },
    { kind: 'edit', decision: 'allow' },
    { kind: 'execute', decision: 'allow' },
    { kind: 'read', pattern: '.env', decision: 'deny' },
    { kind: 'read', pattern: 'secrets/**', decision: 'deny' },
  ],
};

const toPosix = (path: string) => path.split('\\').join('/');

const decisionOf = async (
  repoDir: string,
  toolCall: ToolCallUpdate,
  machine: Permissions = MACHINE,
): Promise<Decision> => {
  const layers: PermissionLayers = { machine };
  let carded = false;
  const policy = createPermissionPolicy({
    repoDir,
    loadLayers: () => Promise.resolve(layers),
    cardHuman: () => {
      carded = true;
      return Promise.resolve('deny');
    },
  });
  const response = await policy({ sessionId: 's', toolCall, options: OPTIONS });
  if (carded) return 'ask';
  if (
    response.outcome.outcome === 'selected' &&
    response.outcome.optionId === 'yes'
  ) {
    return 'allow';
  }
  return 'deny';
};

const read = (path: string): ToolCallUpdate => ({
  toolCallId: 'read',
  kind: 'read',
  locations: [{ path }],
});

const shell = (command: string, cwd = '.'): ToolCallUpdate => ({
  toolCallId: 'bash',
  kind: 'execute',
  rawInput: { command, cwd },
});

describe('symlinks and canonical paths', () => {
  let box: Sandbox = { root: '', repo: '', outside: '', repoLink: '' };

  beforeAll(async () => {
    const root = await realpath(
      await mkdtemp(resolve(tmpdir(), 'quarterdeck-links-')),
    );
    box = {
      root,
      repo: join(root, 'repo'),
      outside: join(root, 'outside'),
      repoLink: join(root, 'repo-link'),
    };
    await mkdir(join(box.repo, 'src'), { recursive: true });
    await mkdir(join(box.repo, 'secrets'));
    await mkdir(box.outside);
    await writeFile(join(box.repo, '.env'), 'TOKEN=1\n');
    await writeFile(join(box.repo, 'src/a.ts'), 'export {};\n');
    await writeFile(join(box.repo, 'secrets/key'), 'k\n');
    await writeFile(join(box.outside, 'secret'), 's\n');
    await symlink('.env', join(box.repo, 'innocent.txt'));
    await symlink('../outside/secret', join(box.repo, 'leak'));
    await symlink('../outside', join(box.repo, 'leakdir'));
    await symlink('../outside/not-yet', join(box.repo, 'dangling'));
    await symlink('loop-b', join(box.repo, 'loop-a'));
    await symlink('loop-a', join(box.repo, 'loop-b'));
    await symlink(box.repo, box.repoLink);
  });

  afterAll(async () => {
    await rm(box.root, { recursive: true, force: true });
  });

  it('resolves the longest existing prefix and keeps the missing tail', async () => {
    expect(await canonicalPath(join(box.repoLink, 'src/new/file.ts'))).toBe(
      join(box.repo, 'src/new/file.ts'),
    );
    expect(await canonicalPath(join(box.repo, 'leakdir/x'))).toBe(
      join(box.outside, 'x'),
    );
    expect(await canonicalPath(join(box.repo, 'dangling'))).toBe(
      join(box.outside, 'not-yet'),
    );
  });

  it('denies a symlink that points at a denied file', async () => {
    expect(await decisionOf(box.repo, read(join(box.repo, '.env')))).toBe(
      'deny',
    );
    expect(
      await decisionOf(box.repo, read(join(box.repo, 'innocent.txt'))),
    ).toBe('deny');
  });

  it('cards a symlink that points outside the repo', async () => {
    expect(await decisionOf(box.repo, read(join(box.repo, 'leak')))).toBe(
      'ask',
    );
    expect(
      await decisionOf(box.repo, read(join(box.repo, 'leakdir/secret'))),
    ).toBe('ask');
    expect(
      await decisionOf(box.repo, {
        toolCallId: 'edit',
        kind: 'edit',
        locations: [{ path: join(box.repo, 'dangling') }],
      }),
    ).toBe('ask');
  });

  it('cards shell commands whose arguments or cwd are symlinks out of the repo', async () => {
    expect(await decisionOf(box.repo, shell('cat src/a.ts'))).toBe('allow');
    expect(await decisionOf(box.repo, shell('cat leak'))).toBe('ask');
    expect(await decisionOf(box.repo, shell('ls', 'leakdir'))).toBe('ask');
  });

  it('fails closed on a symlink loop', async () => {
    expect(await decisionOf(box.repo, read(join(box.repo, 'loop-a')))).toBe(
      'deny',
    );
  });

  it('pins to the real repo when the repo is reached through a symlink', async () => {
    expect(
      await decisionOf(box.repoLink, read(join(box.repo, 'src/a.ts'))),
    ).toBe('allow');
    expect(
      await decisionOf(box.repoLink, read(join(box.repoLink, 'src/a.ts'))),
    ).toBe('allow');
    expect(
      await decisionOf(box.repoLink, read(join(box.repoLink, '.env'))),
    ).toBe('deny');
  });

  it('cards reads outside the repo and of no path, and allows repo reads', async () => {
    expect(await decisionOf(box.repo, read('~/.ssh/x'))).toBe('ask');
    expect(await decisionOf(box.repo, read('src/a.ts'))).toBe('allow');
    expect(await decisionOf(box.repo, { toolCallId: 'r', kind: 'read' })).toBe(
      'ask',
    );
    expect(
      await decisionOf(box.repo, {
        toolCallId: 'g',
        kind: 'search',
        rawInput: { path: box.outside },
      }),
    ).toBe('ask');
  });

  it('lets an explicit absolute pattern allow a read outside the repo', async () => {
    const machine: Permissions = {
      ...MACHINE,
      rules: [
        ...MACHINE.rules,
        {
          kind: 'read',
          pattern: `${toPosix(box.outside)}/**`,
          decision: 'allow',
        },
      ],
    };

    expect(
      await decisionOf(box.repo, read(join(box.repo, 'leak')), machine),
    ).toBe('allow');
    expect(
      await decisionOf(
        box.repo,
        {
          toolCallId: 'e',
          kind: 'edit',
          locations: [{ path: join(box.repo, 'leak') }],
        },
        machine,
      ),
    ).toBe('ask');
  });

  it('decides a tool carrying a command as a shell command too', async () => {
    expect(
      await decisionOf(box.repo, {
        toolCallId: 'r',
        kind: 'read',
        locations: [{ path: join(box.repo, 'src/a.ts') }],
        rawInput: { command: 'cat ~/.ssh/id_rsa' },
      }),
    ).toBe('ask');
    expect(
      await decisionOf(
        box.repo,
        {
          toolCallId: 'r',
          kind: 'read',
          locations: [{ path: join(box.repo, 'src/a.ts') }],
          rawInput: { command: 'cat src/a.ts' },
        },
        {
          ...MACHINE,
          rules: [
            ...MACHINE.rules,
            { kind: 'execute', pattern: 'cat *', decision: 'deny' },
          ],
        },
      ),
    ).toBe('deny');
  });
});
