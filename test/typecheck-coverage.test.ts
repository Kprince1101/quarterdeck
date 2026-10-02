import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc');
const TYPE_ERROR = "export const probe: number = 'not a number';\n";
const PROBES = [
  'packages/server/test/probe.test.ts',
  'packages/dashboard/src/Probe.tsx',
];

const writeProbe = (fixture: string, path: string) => {
  const target = resolve(fixture, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, TYPE_ERROR);
};

describe('root tsconfig coverage', () => {
  let fixture = '';

  beforeAll(() => {
    fixture = mkdtempSync(resolve(ROOT, 'node_modules/.tsc-coverage-'));
    copyFileSync(
      resolve(ROOT, 'tsconfig.json'),
      resolve(fixture, 'tsconfig.json'),
    );
    PROBES.forEach((path) => writeProbe(fixture, path));
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('fails on type errors in package tests and .tsx files', () => {
    const result = spawnSync(
      process.execPath,
      [TSC, '-p', resolve(fixture, 'tsconfig.json')],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    PROBES.forEach((path) => expect(result.stdout).toContain(path));
  });
});
