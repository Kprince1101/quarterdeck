import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandSegments,
  describeToolCall,
  isInsideRepo,
  isPinnedCommand,
  pathSubject,
} from '@quarterdeck/server';
import { REPO_DIR } from './arbitraries.ts';

describe('tool call description', () => {
  it('reads the kind, locations, diff paths and raw input paths', () => {
    const request = describeToolCall(
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

  it('reads a shell command, its working directory and a url', () => {
    expect(
      describeToolCall(
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
    });
    expect(
      describeToolCall(
        {
          toolCallId: 'fetch-1',
          kind: 'fetch',
          rawInput: { url: 'https://example.com' },
        },
        REPO_DIR,
      ).url,
    ).toBe('https://example.com');
  });

  it('treats a missing or unknown kind as other and odd raw input as empty', () => {
    expect(
      describeToolCall({ toolCallId: 'x', rawInput: 'rm -rf /' }, REPO_DIR),
    ).toEqual({ kind: 'other', cwd: REPO_DIR, paths: [] });
    expect(
      describeToolCall(
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
});

describe('shell pinning', () => {
  it('splits a command into the segments the shell would run', () => {
    expect(
      commandSegments('npm test && rm -rf x; ls | wc -l || true &'),
    ).toEqual(['npm test', 'rm -rf x', 'ls', 'wc -l', 'true']);
  });

  it('pins simple commands that stay inside the repo', () => {
    expect(isPinnedCommand(REPO_DIR, REPO_DIR, 'npm test')).toBe(true);
    expect(isPinnedCommand(REPO_DIR, REPO_DIR, 'cat src/../README.md')).toBe(
      true,
    );
    expect(
      isPinnedCommand(REPO_DIR, resolve(REPO_DIR, 'src'), 'cat ../README.md'),
    ).toBe(true);
  });

  it('refuses to pin commands that escape the repo', () => {
    expect(isPinnedCommand(REPO_DIR, REPO_DIR, 'cat ../other/x')).toBe(false);
    expect(isPinnedCommand(REPO_DIR, REPO_DIR, 'cat "/etc/passwd"')).toBe(
      false,
    );
    expect(isPinnedCommand(REPO_DIR, REPO_DIR, 'ls ~')).toBe(false);
    expect(isPinnedCommand(REPO_DIR, REPO_DIR, 'tool --out=/tmp/x')).toBe(
      false,
    );
    expect(isPinnedCommand(REPO_DIR, REPO_DIR, 'echo $(pwd)')).toBe(false);
    expect(isPinnedCommand(REPO_DIR, resolve('/tmp'), 'ls')).toBe(false);
  });
});
