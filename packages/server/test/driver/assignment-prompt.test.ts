import { forgeTerms } from '@quarterdeck/rules';
import { describe, expect, it } from 'vitest';
import { buildAssignmentPrompt } from '../../src/driver/assignment-prompt.js';
import { FAKE_SPEC_BODY } from '../acp/fake-agent/index.ts';

describe('buildAssignmentPrompt', () => {
  it('tells the builder to work the Tasks list in order and prove the Proven line', () => {
    expect(
      buildAssignmentPrompt({
        builder: { name: 'crane' },
        ticket: {
          id: '00000000-0000-4000-8000-000000000009',
          title: 'Fix the README greeting',
          body: FAKE_SPEC_BODY,
          prUrl: null,
          headSha: null,
        },
        worktreePath: '/work/crane',
        repoPath: '/repo',
        base: 'origin/main',
        terms: forgeTerms('github'),
      }),
    ).toMatchInlineSnapshot(`
      "You are crane, a builder on this project.

      # Ticket 00000000-0000-4000-8000-000000000009: Fix the README greeting

      ## Requirements

      - As a reader, I want the README to greet me, so that I feel welcome.
        - WHEN someone opens the README THE SYSTEM SHALL show Hello on its first line.

      ## Design

      Edit README.md only.

      ## Tasks

      1. Add the greeting.
      2. Test that it shows.

      Proven: the README starts with Hello.

      Work the ticket's \`## Tasks\` list in order, one task at a time. Before you report, prove its \`Proven:\` line: run or show the check it names.

      # Where to work

      Work in /work/crane, your git worktree of /repo, detached at origin/main. Create a branch there, commit, push and open a pull request. Never touch /repo itself.

      # When you are done

      Call the bus tool \`report\` with ticket \`00000000-0000-4000-8000-000000000009\`, the pull request URL, its head commit and what you tested. If you need a decision only a person can make, call \`ask\`. Use \`status\` for a one-line progress note."
    `);
  });
});
