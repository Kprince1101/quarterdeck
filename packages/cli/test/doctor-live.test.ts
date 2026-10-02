import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runDoctorChecks } from '../src/index.js';
import { testIo } from './harness.js';

const LIVE =
  process.env['QUARTERDECK_LIVE'] === '1' ||
  process.env['QUARTERDECK_KIRO_LIVE'] === '1';

describe.skipIf(!LIVE)('quarterdeck doctor live (signed-in kiro-cli)', () => {
  it('finds the real kiro-cli signed in', async () => {
    const checks = await runDoctorChecks(testIo(homedir()));
    const kiro = checks.find((check) => check.name === 'kiro-cli');
    expect(kiro?.fixes).toEqual([]);
    expect(kiro?.state).toMatch(/, signed in/);
  });
});
