import { describe, expect, it } from 'vitest';
import {
  cardCwd,
  createScrubber,
  permissionAnswer,
  type PermissionAnswer,
} from './policy.ts';

const ROOTS = ['/work/repo', '/tmp/qdp-1'];
const WORKTREE = '/tmp/qdp-1/wt';

const answer = (question: string, cwd: string = WORKTREE): PermissionAnswer =>
  permissionAnswer(question, cwd, ROOTS);

const asked = (command: string): PermissionAnswer =>
  answer(`heron asks to run ${command}: ${command}.`);

describe('cardCwd', () => {
  it('reads the cwd from a permission card’s recommendation', () => {
    expect(
      cardCwd('Allow it only if heron should do this in /tmp/qdp-1/wt.'),
    ).toBe('/tmp/qdp-1/wt');
  });

  it('gives nothing for a missing or unexpected recommendation', () => {
    expect(cardCwd(null)).toBeUndefined();
    expect(cardCwd('Allow it.')).toBeUndefined();
  });
});

describe('permissionAnswer', () => {
  it('allows a command whose paths stay inside the allowed roots', () => {
    expect(asked('git -C /tmp/qdp-1/wt status')).toBe('allow');
    expect(asked('gh pr diff https://github.com/o/r/pull/1')).toBe('allow');
  });

  it('denies a command run from a cwd outside the roots, or with no cwd', () => {
    expect(answer('wren asks to run cat passwd.', '/etc')).toBe('deny');
    expect(answer('wren asks to run ls.', '/work/repository')).toBe('deny');
    expect(answer('wren asks to run ls.', '/work/repo/../x')).toBe('deny');
    expect(permissionAnswer('wren asks to run ls.', undefined, ROOTS)).toBe(
      'deny',
    );
  });

  it('denies a command with a path outside the roots', () => {
    expect(answer('wren asks to run Read: /etc/passwd.')).toBe('deny');
    expect(answer('wren asks to run cat /work/repository/x.')).toBe('deny');
  });

  it('denies a command on the root directory itself', () => {
    expect(asked('find / -name id_rsa')).toBe('deny');
    expect(asked('ls /')).toBe('deny');
    expect(asked('du -sh /.')).toBe('deny');
  });

  it('denies paths it cannot resolve from the card text', () => {
    for (const command of [
      'cat ../../.ssh/id_rsa',
      'cd .. && ls',
      'cat /work/repo/../outside/x',
      'cat ~/.ssh/id_rsa',
      'cat $HOME/.ssh/id_rsa',
      'cat ${HOME}/x',
      'echo $(whoami)',
      'echo `whoami`',
    ])
      expect(asked(command)).toBe('deny');
  });

  it('allows removing a single file', () => {
    expect(asked('rm -f /tmp/qdp-1/wt/a.txt')).toBe('allow');
  });

  it('tells a parent path from a file name with dots', () => {
    expect(asked('npx prettier --check ./README.md ../repo.md')).toBe('deny');
    expect(asked('npx prettier --check ./README.md .prettierrc..')).toBe(
      'allow',
    );
  });

  it('allows a push of a feature branch', () => {
    for (const command of [
      'git push -u origin docs/fix-typo',
      'git push -q --set-upstream origin docs/fix-typo',
      'git -C /tmp/qdp-1/wt push origin fix:docs/fix-typo',
      'git push origin refs/heads/fix',
      'cd /tmp/qdp-1/wt && git commit -qam "docs: fix typo" && git push origin fix',
    ])
      expect(asked(command)).toBe('allow');
  });

  it('allows switching to, creating and listing other branches', () => {
    for (const command of [
      'git switch -c docs/fix-typo',
      'git checkout -b docs/fix-typo origin/main',
      'git checkout HEAD -- README.md',
      'git branch --show-current',
      'git --no-pager log -1',
      'git -C /tmp/qdp-1/wt -P diff',
    ])
      expect(asked(command)).toBe('allow');
  });

  it('denies moving or checking out main or master', () => {
    for (const command of [
      'git switch main',
      'git switch -C master',
      'git checkout main',
      'git checkout -B main origin/main',
      'git branch -f main HEAD',
      'git branch -M fix master',
      'git update-ref refs/heads/main HEAD',
      'git update-ref refs/heads/master abc123',
      'git checkout ma\\in',
      'git switch "main"',
    ])
      expect(asked(command)).toBe('deny');
  });

  it('denies a push whose text is quoted or escaped', () => {
    for (const command of [
      'git pu\\sh origin main',
      "git push origin ma'in'",
      'git push origin "fix"',
      'git "push" origin fix',
      'g\\it push origin main',
      "sh -c 'git push origin main'",
      'git push origin fix\\',
    ])
      expect(asked(command)).toBe('deny');
  });

  it('denies a push to the default branch, a forced or deleting refspec, or a bulk push', () => {
    for (const command of [
      'git push origin main',
      'git push origin master',
      'git push origin HEAD:main',
      'git push origin feature:refs/heads/main',
      'git push origin main:feature',
      'git push origin refs/heads/master:feature',
      'git push origin HEAD',
      'git push origin HEAD:feature',
      'git push origin @',
      'git push origin @:feature',
      'git push origin feature@{1}:feature',
      'git push origin feature~1:feature',
      'git push origin feature^:feature',
      'git push origin refs/heads/*:refs/heads/*',
      'git push origin *',
      'git push origin a:b:c',
      'git push origin fix 2>&1 | tail -2',
      'git push --no-verify origin fix',
      'git push --push-option=x origin fix',
      'git push origin +HEAD:feature',
      'git push origin :feature',
      'git push',
      'git push origin',
      'git push --mirror origin',
      'git push --all origin',
      'git push --delete origin feature',
      'git push -d origin feature',
      'git push --tags origin',
      'git push --follow-tags origin feature',
      'git push --receive-pack=x origin feature',
      'git push --exec=x origin feature',
      'git push -uf origin feature',
      'git push --force-with-lease origin feature',
      'git -C /tmp/qdp-1/wt push origin main',
      'cd /tmp/qdp-1/wt && git push origin feature && git push origin main',
      'echo git & git push origin main',
      'git -c alias.ship=push ship origin main',
      'git -C /tmp/qdp-1/wt -c alias.ship=push ship origin feature',
      'git --config-env=alias.ship=SHIP ship origin main',
      'git config alias.ship push && git ship origin main',
      'git config --local alias.ship push',
      'git --work-tree rules push origin main',
      'git --git-dir .git push origin fix',
      'git --exec-path=/tmp/qdp-1 push origin fix',
      'git -p push origin main',
      'echo git git push origin main',
      'git status; git push origin main',
    ])
      expect(asked(command)).toBe('deny');
  });

  it('denies merging however the command is spaced', () => {
    for (const command of [
      'gh  pr  merge 72 --squash',
      'gh --repo o/r pr merge 72',
      'gh\tpr merge 72',
      'gh api -X PUT repos/o/r/pulls/72/merge',
    ])
      expect(asked(command)).toBe('deny');
  });

  it('denies merging, force-pushing and deleting whatever the paths', () => {
    for (const command of [
      'gh pr merge 3 --squash',
      'git push --force origin x',
      'git push -f origin x',
      'rm -rf /tmp/qdp-1/wt',
      'rm -fr /tmp/qdp-1/wt',
      'rm -Rf /tmp/qdp-1/wt',
      'rm -r /tmp/qdp-1/wt',
      'rm -R /tmp/qdp-1/wt',
      'rm --recursive /tmp/qdp-1/wt',
      'rm -f -r /tmp/qdp-1/wt',
      'cd /tmp/qdp-1 && rm -fR wt',
      'git reset --hard HEAD~1',
      'git reset -q --hard HEAD',
      'git reset --quiet --hard',
      'curl https://example.com',
    ])
      expect(asked(command)).toBe('deny');
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
