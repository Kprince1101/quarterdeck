import { readFileSync, readdirSync } from 'node:fs';
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
  scripts?: Record<string, string>;
  bin?: Record<string, string>;
  publishConfig?: unknown;
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

  it.each(['rules', 'packages/server', 'packages/cli'])(
    '%s clears dist before it builds, so nothing stale ships',
    (dir) => {
      expect(readManifest(dir).scripts?.build?.startsWith(CLEAR_DIST)).toBe(
        true,
      );
    },
  );

  it.each(ALL_MANIFESTS)('%s has nothing that publishes it', (dir) => {
    const manifest = readManifest(dir);
    expect(manifest.publishConfig).toBeUndefined();
    Object.values(manifest.scripts ?? {}).forEach((script) =>
      expect(script).not.toMatch(/\bpublish\b/),
    );
  });

  it('no workflow publishes a package', () => {
    const workflows = resolve(ROOT, '.github', 'workflows');
    readdirSync(workflows).forEach((file) =>
      expect(readFileSync(resolve(workflows, file), 'utf8')).not.toMatch(
        /\bpublish\b/,
      ),
    );
  });

  it('cli is @quarterdeck/cli, never the unrelated quarterdeck on npm, with the quarterdeck bin', () => {
    const manifest = readManifest('packages/cli');
    expect(manifest.name).toBe('@quarterdeck/cli');
    expect(manifest.bin).toEqual({ quarterdeck: './dist/bin.js' });
  });

  it('root runs the cli from the clone, built on install', () => {
    const { scripts } = readManifest('.');
    expect(scripts?.quarterdeck).toBe('node scripts/quarterdeck.mjs');
    expect(scripts?.prepare).toBe('npm run build');
  });
});
