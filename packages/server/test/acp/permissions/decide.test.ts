import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadPermissionLayers } from '@quarterdeck/rules';
import type { PermissionLayers, Permissions } from '@quarterdeck/rules';
import { decidePermission, pathSubject } from '@quarterdeck/server';
import type { ToolRequest } from '@quarterdeck/server';
import {
  INSIDE_PATHS,
  OUTSIDE_CWDS,
  OUTSIDE_PATHS,
  PINNED_COMMANDS,
  RANK,
  REPO_DIR,
  UNPINNED_COMMANDS,
  layersArb,
  machineArb,
  repoArb,
  requestArb,
  toolKindArb,
} from './arbitraries.ts';

const ALLOW_ALL: Permissions = { default: 'allow', rules: [] };

const decide = (layers: PermissionLayers, request: ToolRequest) =>
  decidePermission(layers, request, REPO_DIR);

const execute = (command: string, cwd = REPO_DIR): ToolRequest => ({
  kind: 'execute',
  cwd,
  paths: [],
  command,
});

const edit = (...paths: string[]): ToolRequest => ({
  kind: 'edit',
  cwd: REPO_DIR,
  paths,
});

const writeKindArb = fc.constantFrom('edit' as const, 'delete', 'move');
const readKindArb = fc.constantFrom('read' as const, 'search');

describe('permission matcher', () => {
  it('answers from the shipped defaults: reads allowed, edits and shell carded', async () => {
    const layers = await loadPermissionLayers({ homeDir: resolve('/none') });

    expect(
      decide(layers, {
        kind: 'read',
        cwd: REPO_DIR,
        paths: [resolve(REPO_DIR, 'src/index.ts')],
      }),
    ).toBe('allow');
    expect(decide(layers, edit(resolve(REPO_DIR, 'src/index.ts')))).toBe('ask');
    expect(decide(layers, execute('npm test'))).toBe('ask');
  });

  it('lets a pattern rule override the kind-wide rule', () => {
    const layers: PermissionLayers = {
      machine: {
        default: 'deny',
        rules: [
          { kind: 'execute', decision: 'ask' },
          { kind: 'execute', pattern: 'npm test', decision: 'allow' },
          { kind: 'edit', pattern: 'src/**', decision: 'allow' },
          { kind: 'edit', pattern: '**/*.lock', decision: 'deny' },
        ],
      },
    };

    expect(decide(layers, execute('npm test'))).toBe('allow');
    expect(decide(layers, execute('npm run build'))).toBe('ask');
    expect(decide(layers, edit(resolve(REPO_DIR, 'src/a.ts')))).toBe('allow');
    expect(decide(layers, edit(resolve(REPO_DIR, 'README.md')))).toBe('deny');
    expect(decide(layers, edit(resolve(REPO_DIR, 'src/npm.lock')))).toBe(
      'deny',
    );
  });

  it('takes the strictest answer across every path a request touches', () => {
    const layers: PermissionLayers = {
      machine: {
        default: 'allow',
        rules: [{ kind: 'edit', pattern: '.env', decision: 'deny' }],
      },
    };

    expect(
      decide(
        layers,
        edit(resolve(REPO_DIR, 'src/a.ts'), resolve(REPO_DIR, '.env')),
      ),
    ).toBe('deny');
  });

  it('denies a compound command when any segment is denied', () => {
    const layers: PermissionLayers = {
      machine: {
        default: 'allow',
        rules: [{ kind: 'execute', pattern: 'rm *', decision: 'deny' }],
      },
    };

    expect(decide(layers, execute('npm test && rm -rf src'))).toBe('deny');
    expect(decide(layers, execute('npm test; rm -rf src'))).toBe('deny');
    expect(decide(layers, execute('npm test'))).toBe('allow');
  });

  it('cards a request whose subject is unknown when a pattern guards its kind', () => {
    const layers: PermissionLayers = {
      machine: {
        default: 'allow',
        rules: [
          { kind: 'fetch', pattern: 'https://evil.test/**', decision: 'deny' },
        ],
      },
    };

    expect(decide(layers, { kind: 'fetch', cwd: REPO_DIR, paths: [] })).toBe(
      'ask',
    );
    expect(
      decide(layers, {
        kind: 'fetch',
        cwd: REPO_DIR,
        paths: [],
        url: 'https://evil.test/x',
      }),
    ).toBe('deny');
  });

  it('allows a shell command that stays inside the repo', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PINNED_COMMANDS), (command) => {
        expect(decide({ machine: ALLOW_ALL }, execute(command))).toBe('allow');
      }),
    );
  });

  it('never allows a shell command that leaves the repo or chains commands', () => {
    fc.assert(
      fc.property(
        layersArb,
        fc.constantFrom(...UNPINNED_COMMANDS),
        (layers, command) => {
          expect(decide(layers, execute(command))).not.toBe('allow');
          expect(decide({ machine: ALLOW_ALL }, execute(command))).toBe('ask');
        },
      ),
    );
  });

  it('never allows a shell command run from outside the repo', () => {
    fc.assert(
      fc.property(
        layersArb,
        fc.constantFrom(...PINNED_COMMANDS),
        fc.constantFrom(...OUTSIDE_CWDS),
        (layers, command, cwd) => {
          expect(decide(layers, execute(command, cwd))).not.toBe('allow');
        },
      ),
    );
  });

  it('never allows a shell request whose command is unknown', () => {
    fc.assert(
      fc.property(layersArb, (layers) => {
        expect(
          decide(layers, { kind: 'execute', cwd: REPO_DIR, paths: [] }),
        ).not.toBe('allow');
      }),
    );
  });

  it('never allows a write outside the repo', () => {
    fc.assert(
      fc.property(
        layersArb,
        writeKindArb,
        fc.constantFrom(...OUTSIDE_PATHS),
        fc.subarray(INSIDE_PATHS),
        (layers, kind, outside, inside) => {
          const request = { kind, cwd: REPO_DIR, paths: [...inside, outside] };
          expect(decide(layers, request)).not.toBe('allow');
        },
      ),
    );
  });

  it('never allows a read or search outside the repo that no absolute pattern names', () => {
    fc.assert(
      fc.property(
        layersArb,
        readKindArb,
        fc.constantFrom(...OUTSIDE_PATHS),
        fc.subarray(INSIDE_PATHS),
        (layers, kind, outside, inside) => {
          const unnamed = {
            ...layers,
            machine: {
              ...layers.machine,
              rules: layers.machine.rules.filter(
                (rule) =>
                  rule.pattern === undefined || !isAbsolute(rule.pattern),
              ),
            },
          };
          const request = { kind, cwd: REPO_DIR, paths: [...inside, outside] };
          expect(decide(unnamed, request)).not.toBe('allow');
        },
      ),
    );
  });

  it('never allows a read or search with no visible path', () => {
    fc.assert(
      fc.property(layersArb, readKindArb, (layers, kind) => {
        expect(decide(layers, { kind, cwd: REPO_DIR, paths: [] })).not.toBe(
          'allow',
        );
      }),
    );
  });

  it('cards a read of a home secret and allows a read in the repo with the shipped defaults', async () => {
    const layers = await loadPermissionLayers({ homeDir: resolve('/none') });
    const readOf = (path: string): ToolRequest => ({
      kind: 'read',
      cwd: REPO_DIR,
      paths: [path],
    });

    expect(decide(layers, readOf(join(homedir(), '.ssh/x')))).toBe('ask');
    expect(decide(layers, readOf(resolve(REPO_DIR, 'src/a.ts')))).toBe('allow');
  });

  it('lets an absolute pattern allow a named read outside the repo, never a write', () => {
    const layers: PermissionLayers = {
      machine: {
        default: 'allow',
        rules: [
          { kind: 'read', pattern: '/usr/share/**', decision: 'allow' },
          { kind: 'edit', pattern: '/usr/share/**', decision: 'allow' },
          { kind: 'read', pattern: '**/*.txt', decision: 'allow' },
        ],
      },
    };
    const at = (kind: 'read' | 'edit', path: string): ToolRequest => ({
      kind,
      cwd: REPO_DIR,
      paths: [path],
    });

    expect(decide(layers, at('read', '/usr/share/dict/words'))).toBe('allow');
    expect(decide(layers, at('edit', '/usr/share/dict/words'))).toBe('ask');
    expect(decide(layers, at('read', '/etc/notes.txt'))).toBe('ask');
  });

  it('decides any request carrying a command at least as strictly as a shell command', () => {
    fc.assert(
      fc.property(layersArb, requestArb(), (layers, request) => {
        fc.pre(request.command !== undefined);
        const asShell = decide(layers, { ...request, kind: 'execute' });
        expect(RANK[decide(layers, request)]).toBeGreaterThanOrEqual(
          RANK[asShell],
        );
      }),
    );
  });

  it('only ever tightens with the repo layer', () => {
    fc.assert(
      fc.property(
        machineArb,
        repoArb,
        requestArb(),
        (machine, repo, request) => {
          const base = decide({ machine }, request);
          const layered = decide({ machine, repo }, request);
          expect(RANK[layered]).toBeGreaterThanOrEqual(RANK[base]);
        },
      ),
    );
  });

  it('denies everything when the repo layer defaults to deny', () => {
    fc.assert(
      fc.property(machineArb, requestArb(), (machine, request) => {
        expect(decide({ machine, repo: { default: 'deny' } }, request)).toBe(
          'deny',
        );
      }),
    );
  });

  it('cannot be loosened by a repo layer even against a deny-all machine', () => {
    fc.assert(
      fc.property(repoArb, requestArb(), (repo, request) => {
        expect(
          decide({ machine: { default: 'deny', rules: [] }, repo }, request),
        ).toBe('deny');
      }),
    );
  });

  it('denies whenever a deny rule names one of the request paths', () => {
    fc.assert(
      fc.property(
        layersArb,
        fc.constantFrom('read' as const, 'edit', 'delete', 'move', 'search'),
        fc.constantFrom(...INSIDE_PATHS),
        fc.subarray(INSIDE_PATHS),
        (layers, kind, target, others) => {
          const guarded: PermissionLayers = {
            ...layers,
            machine: {
              ...layers.machine,
              rules: [
                ...layers.machine.rules,
                {
                  kind,
                  pattern: pathSubject(REPO_DIR, target),
                  decision: 'deny',
                },
              ],
            },
          };
          const request = { kind, cwd: REPO_DIR, paths: [...others, target] };
          expect(decide(guarded, request)).toBe('deny');
        },
      ),
    );
  });

  it('does not depend on the order of the rules', () => {
    fc.assert(
      fc.property(
        layersArb,
        requestArb(),
        fc.infiniteStream(fc.nat()),
        (layers, request, picks) => {
          const iterator = picks[Symbol.iterator]();
          const shuffled = layers.machine.rules
            .map((rule) => ({ rule, key: iterator.next().value ?? 0 }))
            .toSorted((left, right) => left.key - right.key)
            .map(({ rule }) => rule);
          const reordered = {
            ...layers,
            machine: { ...layers.machine, rules: shuffled },
          };
          expect(decide(reordered, request)).toBe(decide(layers, request));
        },
      ),
    );
  });

  it('ignores rules written for a different kind', () => {
    fc.assert(
      fc.property(
        layersArb,
        requestArb(toolKindArb),
        toolKindArb,
        (layers, request, otherKind) => {
          fc.pre(otherKind !== request.kind);
          fc.pre(otherKind !== 'execute' || request.command === undefined);
          const extra: PermissionLayers = {
            ...layers,
            machine: {
              ...layers.machine,
              rules: [
                ...layers.machine.rules,
                { kind: otherKind, decision: 'deny' },
              ],
            },
          };
          expect(decide(extra, request)).toBe(decide(layers, request));
        },
      ),
    );
  });
});
