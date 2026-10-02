import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandArguments,
  commandSegments,
  describeToolCall,
  expandHome,
  isInsideRepo,
  isPinnedCommand,
  pathSubject,
} from '@quarterdeck/server';
import { REPO_DIR } from './arbitraries.ts';

describe('tool call description', () => {
  it('reads the kind, locations, diff paths and raw input paths', async () => {
    const request = await describeToolCall(
      {
        toolCallId: 'edit-1',
        kind: 'move',
        locations: [{ path: resolve(REPO_DIR, 'a.ts') }],
        content: [
          { type: 'diff', path: resolve(REPO_DIR, 'b.ts'), newText: 'x' },
        ],
        rawInput: { source: 'c.ts', destination: '../escape.ts' },
      },
      REPO_DIR,
    );

    expect(request).toEqual({
      kind: 'move',
      cwd: REPO_DIR,
      paths: [
        resolve(REPO_DIR, 'a.ts'),
        resolve(REPO_DIR, 'b.ts'),
        resolve(REPO_DIR, 'c.ts'),
        resolve(REPO_DIR, '../escape.ts'),
      ],
    });
  });

  it('expands a home path instead of reading it as a repo folder', async () => {
    const request = await describeToolCall(
      {
        toolCallId: 'read-1',
        kind: 'read',
        rawInput: { file_path: '~/.ssh/x' },
      },
      REPO_DIR,
    );

    expect(isInsideRepo(REPO_DIR, request.paths[0] ?? REPO_DIR)).toBe(false);
  });

  it('reads a shell command, its arguments, its working directory and a url', async () => {
    expect(
      await describeToolCall(
        {
          toolCallId: 'bash-1',
          kind: 'execute',
          rawInput: { command: ['npm', 'test'], cwd: 'packages/server' },
        },
        REPO_DIR,
      ),
    ).toEqual({
      kind: 'execute',
      cwd: resolve(REPO_DIR, 'packages/server'),
      paths: [],
      command: 'npm test',
      argPaths: [
        resolve(REPO_DIR, 'packages/server/npm'),
        resolve(REPO_DIR, 'packages/server/test'),
      ],
    });
    expect(
      (
        await describeToolCall(
          {
            toolCallId: 'fetch-1',
            kind: 'fetch',
            rawInput: { url: 'https://example.com' },
          },
          REPO_DIR,
        )
      ).url,
    ).toBe('https://example.com');
  });

  it('keeps a command carried by a tool of another kind', async () => {
    const request = await describeToolCall(
      { toolCallId: 'r', kind: 'read', rawInput: { command: 'cat x' } },
      REPO_DIR,
    );

    expect(request).toMatchObject({ kind: 'read', command: 'cat x' });
  });

  it('treats a missing or unknown kind as other and odd raw input as empty', async () => {
    expect(
      await describeToolCall(
        { toolCallId: 'x', rawInput: 'rm -rf /' },
        REPO_DIR,
      ),
    ).toEqual({ kind: 'other', cwd: REPO_DIR, paths: [] });
    expect(
      await describeToolCall(
        {
          toolCallId: 'y',
          kind: 'teleport' as 'other',
          rawInput: { command: '   ' },
        },
        REPO_DIR,
      ),
    ).toEqual({ kind: 'other', cwd: REPO_DIR, paths: [] });
  });
});

describe('repo paths', () => {
  it('knows which paths sit inside the repo', () => {
    expect(isInsideRepo(REPO_DIR, REPO_DIR)).toBe(true);
    expect(isInsideRepo(REPO_DIR, resolve(REPO_DIR, 'src/a.ts'))).toBe(true);
    expect(isInsideRepo(REPO_DIR, resolve(REPO_DIR, '..'))).toBe(false);
    expect(isInsideRepo(REPO_DIR, `${REPO_DIR}-sibling`)).toBe(false);
    expect(isInsideRepo(REPO_DIR, resolve(REPO_DIR, '..data/x'))).toBe(true);
  });

  it('matches repo paths relative to the repo and others absolute', () => {
    expect(pathSubject(REPO_DIR, resolve(REPO_DIR, 'src/a.ts'))).toBe(
      'src/a.ts',
    );
    expect(pathSubject(REPO_DIR, REPO_DIR)).toBe('.');
    expect(pathSubject(REPO_DIR, resolve('/etc/passwd'))).toBe(
      resolve('/etc/passwd').split('\\').join('/'),
    );
  });

  it('expands ~, ~/path and ~user', () => {
    const home = homedir();
    expect(expandHome('~')).toBe(home);
    expect(expandHome('~/.ssh/x')).toBe(join(home, '.ssh/x'));
    expect(expandHome('~other/x')).toBe(join(dirname(home), 'other/x'));
    expect(expandHome('src/~x')).toBe('src/~x');
  });
});

describe('shell pinning', () => {
  const pinned = (command: string, cwd = REPO_DIR) =>
    isPinnedCommand(REPO_DIR, { cwd, command });

  it('splits a command into the segments the shell would run', () => {
    expect(
      commandSegments('npm test && rm -rf x; ls | wc -l || true &'),
    ).toEqual(['npm test', 'rm -rf x', 'ls', 'wc -l', 'true']);
  });

  it('lists every argument, including the value of --flag=value', () => {
    expect(commandArguments('tool "a b" --out=/tmp/x')).toEqual([
      'tool',
      'a',
      'b',
      '--out=/tmp/x',
      '/tmp/x',
    ]);
  });

  it('pins simple commands that stay inside the repo', () => {
    expect(pinned('npm test')).toBe(true);
    expect(pinned('cat src/../README.md')).toBe(true);
    expect(pinned('cat ../README.md', resolve(REPO_DIR, 'src'))).toBe(true);
  });

  it('refuses to pin commands that escape the repo', () => {
    expect(pinned('cat ../other/x')).toBe(false);
    expect(pinned('cat "/etc/passwd"')).toBe(false);
    expect(pinned('ls ~')).toBe(false);
    expect(pinned('tool --out=/tmp/x')).toBe(false);
    expect(pinned('echo $(pwd)')).toBe(false);
    expect(pinned('ls', resolve('/tmp'))).toBe(false);
  });

  it('refuses to pin a command whose resolved arguments leave the repo', () => {
    expect(
      isPinnedCommand(REPO_DIR, {
        cwd: REPO_DIR,
        command: 'cat innocent.txt',
        argPaths: [resolve(REPO_DIR, 'cat'), resolve('/etc/passwd')],
      }),
    ).toBe(false);
  });
});
