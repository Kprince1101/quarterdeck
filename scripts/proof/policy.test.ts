import { describe, expect, it } from 'vitest';
import { createScrubber, permissionAnswer } from './policy.ts';

const ROOTS = ['/work/repo', '/tmp/qdp-1'];

describe('permissionAnswer', () => {
  it('allows a command whose paths stay inside the allowed roots', () => {
    expect(
      permissionAnswer(
        'wren asks to run git -C /tmp/qdp-1/wt status: git status.',
        ROOTS,
      ),
    ).toBe('allow');
    expect(
      permissionAnswer(
        'heron asks to run gh pr diff https://github.com/o/r/pull/1.',
        ROOTS,
      ),
    ).toBe('allow');
  });

  it('denies a command with a path outside the roots', () => {
    expect(permissionAnswer('wren asks to run Read: /etc/passwd.', ROOTS)).toBe(
      'deny',
    );
    expect(
      permissionAnswer('wren asks to run cat /work/repository/x.', ROOTS),
    ).toBe('deny');
  });

  it('denies merging, force-pushing and deleting whatever the paths', () => {
    for (const command of [
      'gh pr merge 3 --squash',
      'git push --force origin x',
      'git push -f origin x',
      'rm -rf /tmp/qdp-1/wt',
      'git reset --hard HEAD~1',
      'curl https://example.com',
    ])
      expect(permissionAnswer(`wren asks to run ${command}.`, ROOTS)).toBe(
        'deny',
      );
  });
});

describe('createScrubber', () => {
  const scrub = createScrubber({
    home: '/tmp/qdp-1',
    repo: '/work/repo',
    user: 'someone',
    owner: 'SomeOwner',
  });

  it('replaces paths, the remote owner and email addresses', () => {
    expect(
      scrub(
        '/tmp/qdp-1/.quarterdeck /work/repo/README.md /Users/someone/x https://github.com/someowner/q/pull/9 a.b@example.com',
      ),
    ).toBe(
      '$QD_HOME/.quarterdeck $REPO/README.md ~/x https://github.com/<owner>/q/pull/9 <email>',
    );
  });

  it('redacts the API token in the dashboard URL', () => {
    expect(scrub('at http://127.0.0.1:4317/#token=U3g9-Pcc_LQ')).toBe(
      'at http://127.0.0.1:4317/#token=[redacted]',
    );
  });

  it('leaves words that only contain the owner alone', () => {
    expect(scrub('SomeOwners and xSomeOwner')).toBe(
      'SomeOwners and xSomeOwner',
    );
  });
});
