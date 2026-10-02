import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  private?: boolean;
  type?: string;
  license?: string;
  author?: string;
  engines?: { node?: string };
  workspaces?: string[];
  scripts?: { build?: string };
}

const CLEAR_DIST = `node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })" && `;

const ROOT = resolve(import.meta.dirname, '..');
const WORKSPACES = [
  'rules',
  'packages/server',
  'packages/dashboard',
  'packages/cli',
  'site',
];
const ALL_MANIFESTS = ['.', ...WORKSPACES];

const readManifest = (dir: string): PackageManifest =>
  JSON.parse(
    readFileSync(resolve(ROOT, dir, 'package.json'), 'utf8'),
  ) as PackageManifest;

describe('workspace manifests', () => {
  it('root declares every workspace, rules first so it builds before server', () => {
    expect(readManifest('.').workspaces).toEqual(WORKSPACES);
  });

  it.each(ALL_MANIFESTS)('%s credits Kristopher Prince under MIT', (dir) => {
    const manifest = readManifest(dir);
    expect(manifest.license).toBe('MIT');
    expect(manifest.author).toBe('Kristopher Prince');
  });

  it.each(ALL_MANIFESTS)('%s is private ESM on Node 22', (dir) => {
    const manifest = readManifest(dir);
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(manifest.engines?.node).toBe('>=22');
  });

  it.each(['rules', 'packages/server'])(
    '%s clears dist before it builds, so nothing stale ships',
    (dir) => {
      expect(readManifest(dir).scripts?.build?.startsWith(CLEAR_DIST)).toBe(
        true,
      );
    },
  );

  it('cli ships under the quarterdeck name for npx', () => {
    expect(readManifest('packages/cli').name).toBe('quarterdeck');
  });
});
