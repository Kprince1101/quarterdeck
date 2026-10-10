import type { SetupSignIn } from '@quarterdeck/server/intents';
import { describe, expect, it } from 'vitest';
import {
  SETUP_STEPS,
  detectionSummary,
  progressLine,
  settledKeys,
  signInKey,
} from '../../src/setup/setup-model.js';

const signIn = (
  key: string,
  status: SetupSignIn['progress']['status'],
): SetupSignIn => ({
  key,
  tool: { kind: 'gh' },
  name: key,
  progress: { status },
});

describe('setup model', () => {
  it('names the first step not done yet, in four steps', () => {
    expect(SETUP_STEPS.map(({ id }) => id)).toEqual([
      'workspace',
      'runtime',
      'sign-in',
      'go',
    ]);
    const none = {
      workspace: false,
      runtime: false,
      'sign-in': false,
      go: false,
    };
    expect(progressLine(none)).toBe('Step 1 of 4: Workspace');
    expect(progressLine({ ...none, workspace: true, runtime: true })).toBe(
      'Step 3 of 4: Sign in',
    );
    expect(
      progressLine({
        workspace: true,
        runtime: true,
        'sign-in': true,
        go: true,
      }),
    ).toBe('All set');
  });

  it('says one repository or how many', () => {
    expect(detectionSummary(null)).toBeNull();
    expect(
      detectionSummary({
        root: '/r',
        mode: 'multi',
        repositories: [
          { slug: 'a', name: 'a', repoPath: '/r/a', repository: null },
        ],
      }),
    ).toBe('1 repository in /r, each one a project. Untick any to leave out.');
  });

  it('keys sign-ins the way the server does and spots the ones that just settled', () => {
    expect(signInKey({ kind: 'runtime', runtime: 'kiro' })).toBe(
      'runtime:kiro',
    );
    expect(signInKey({ kind: 'glab', host: 'git.example.org' })).toBe(
      'glab:git.example.org',
    );
    expect(signInKey({ kind: 'gh' })).toBe('gh');
    expect(
      settledKeys(
        [signIn('gh', 'waiting'), signIn('kiro', 'waiting')],
        [signIn('gh', 'signed_in'), signIn('kiro', 'waiting')],
      ),
    ).toEqual(['gh']);
    expect(settledKeys([], [signIn('gh', 'failed')])).toEqual([]);
  });
});
