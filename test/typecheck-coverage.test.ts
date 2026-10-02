import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface RootManifest {
  scripts: { typecheck: string };
}

const ROOT = resolve(import.meta.dirname, '..');
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc');
const TYPE_ERROR = "export const probe: number = 'not a number';\n";
const TS_SPECIFIER = "export { probe } from './probe-target.ts';\n";
const PROJECTS = [
  'tsconfig.json',
  'packages/server/test/tsconfig.json',
  'packages/dashboard/tsconfig.json',
];
const PROBES = [
  'packages/server/test/probe.test.ts',
  'packages/server/test/acp/probe.ts',
  'packages/dashboard/src/Probe.tsx',
];
const SOURCE_SPECIFIER_PROBE = 'packages/server/src/probe.ts';

const writeFixtureFile = (fixture: string, path: string, content: string) => {
  const target = resolve(fixture, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const copyProject = (fixture: string, path: string) => {
  mkdirSync(dirname(resolve(fixture, path)), { recursive: true });
  copyFileSync(resolve(ROOT, path), resolve(fixture, path));
};

const typecheck = (fixture: string, project: string) =>
  spawnSync(process.execPath, [TSC, '-p', resolve(fixture, project)], {
    encoding: 'utf8',
  }).stdout;

describe('tsconfig coverage', () => {
  let fixture = '';
  let output = '';

  beforeAll(() => {
    fixture = mkdtempSync(resolve(ROOT, 'node_modules/.tsc-coverage-'));
    PROJECTS.forEach((project) => copyProject(fixture, project));
    PROBES.forEach((path) => writeFixtureFile(fixture, path, TYPE_ERROR));
    writeFixtureFile(fixture, SOURCE_SPECIFIER_PROBE, TS_SPECIFIER);
    writeFixtureFile(
      fixture,
      'packages/server/src/probe-target.ts',
      'export const probe = 1;\n',
    );
    output = PROJECTS.map((project) => typecheck(fixture, project)).join('\n');
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('fails on type errors in package tests and .tsx files', () => {
    PROBES.forEach((path) => expect(output).toContain(path));
  });

  it('rejects .ts import specifiers outside server tests', () => {
    expect(output).toContain(`${SOURCE_SPECIFIER_PROBE}(1,`);
  });

  it('typechecks every project from the typecheck script', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
    ) as RootManifest;
    PROJECTS.filter((project) => project !== 'tsconfig.json').forEach(
      (project) =>
        expect(manifest.scripts.typecheck).toContain(dirname(project)),
    );
  });
});
