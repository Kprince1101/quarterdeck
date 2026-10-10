import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTERNAL = '@quarterdeck/';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const pin = (name, range, version) => {
  if (name.startsWith(INTERNAL)) return version;
  return range;
};

const bumpManifest = (manifest, version) => {
  const bumped = { ...manifest, version };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    bumped[field] = Object.fromEntries(
      Object.entries(deps).map(([name, range]) => [
        name,
        pin(name, range, version),
      ]),
    );
  }
  return bumped;
};

const manifestPath = (dir) => join(ROOT, dir, 'package.json');

const readManifest = (dir) =>
  JSON.parse(readFileSync(manifestPath(dir), 'utf8'));

const manifestDirs = () => ['.', ...readManifest('.').workspaces];

const main = (version) => {
  if (!SEMVER.test(version ?? '')) {
    process.stderr.write(
      'Usage: node scripts/version.mjs <version>, for example 4.0.0\n',
    );
    process.exit(1);
  }
  for (const dir of manifestDirs()) {
    const bumped = bumpManifest(readManifest(dir), version);
    writeFileSync(manifestPath(dir), `${JSON.stringify(bumped, null, 2)}\n`);
    process.stdout.write(`${join(dir, 'package.json')} -> ${version}\n`);
  }
  const lock = spawnSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (lock.status !== 0) process.exit(lock.status ?? 1);
  process.stdout.write(`package-lock.json -> ${version}\n`);
};

main(process.argv[2]);
