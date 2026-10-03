import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { forgeTerms, type Forge } from '@quarterdeck/rules';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBusTools } from '../../src/bus/index.js';
import { wordedTools } from '../../src/bus/wording.js';
import { crewRules } from '../../src/crew/rules.js';
import { buildAssignmentPrompt } from '../../src/driver/index.js';
import { mergeQuestion } from '../../src/gate/index.js';
import { openingPrompt, plannerBrief } from '../../src/planner/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';

const PULL_TERMS = /pull request|\bPRs?\b/i;
const GITLAB = forgeTerms('gitlab');
const GITHUB = forgeTerms('github');
const MR = 'https://git.example.org/example-org/deck/-/merge_requests/7';
const PR = 'https://github.com/example-org/deck/pull/7';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

const assignment = (forge: Forge, prUrl: string | null): string =>
  buildAssignmentPrompt({
    builder: { name: 'okapi' },
    ticket: {
      id: 't1',
      title: 'QD19 forge seam',
      body: 'Generalize the gate.',
      prUrl,
      headSha: HEAD,
    },
    worktreePath: '/wt/okapi',
    repoPath: '/repo',
    base: 'origin/main',
    terms: forgeTerms(forge),
  });

describe('assignment prompt', () => {
  it('says merge request in a GitLab project', () => {
    expect(assignment('gitlab', MR)).toBe(
      [
        'You are okapi, a builder on this project.',
        '# Ticket t1: QD19 forge seam',
        'Generalize the gate.',
        '# Where to work',
        'Work in /wt/okapi, your git worktree of /repo, detached at origin/main. Create a branch there, commit, push and open a merge request. Never touch /repo itself.',
        `A merge request for this ticket is already open: ${MR} (head ${HEAD}). Its builder was retired; check out its branch and carry it on.`,
        '# When you are done',
        'Call the bus tool `report` with ticket `t1`, the merge request URL, its head commit and what you tested. If you need a decision only a person can make, call `ask`. Use `status` for a one-line progress note.',
      ].join('\n\n'),
    );
    expect(assignment('gitlab', MR)).not.toMatch(PULL_TERMS);
  });

  it('says pull request in a GitHub project', () => {
    const prompt = assignment('github', PR);

    expect(prompt).toContain('push and open a pull request.');
    expect(prompt).toContain(
      `A pull request for this ticket is already open: ${PR}`,
    );
    expect(prompt).toContain('the pull request URL, its head commit');
    expect(prompt).not.toMatch(/merge request|\bMR\b/);
  });
});

describe('merge card', () => {
  const ticket = { title: 'QD19 forge seam' };

  it('asks to merge a merge request in a GitLab project', () => {
    expect(
      mergeQuestion(ticket, { pr: MR, head: HEAD }, GITLAB, 'refused'),
    ).toBe(
      [
        `Merge ${MR} for ticket "QD19 forge seam" at ${HEAD}?`,
        'The gate tried to squash merge the MR and failed: refused',
        'merge squash merges the MR; hold leaves it in review for you to merge on GitLab.',
      ].join('\n'),
    );
  });

  it('asks to merge a pull request in a GitHub project', () => {
    expect(
      mergeQuestion(ticket, { pr: PR, head: null }, GITHUB, undefined),
    ).toBe(
      [
        `Merge ${PR} for ticket "QD19 forge seam" at its head?`,
        'merge squash merges the PR; hold leaves it in review for you to merge on GitHub.',
      ].join('\n'),
    );
  });
});

describe('planner brief', () => {
  it('says merge request in a GitLab project', () => {
    const brief = plannerBrief(GITLAB);

    expect(brief).toContain(
      '- One ticket is one merge request one builder can finish.',
    );
    expect(brief).toContain(
      'Do not edit files, run builds or open merge requests.',
    );
    expect(openingPrompt('Charter.', 'Hello', GITLAB)).not.toMatch(PULL_TERMS);
  });

  it('says pull request in a GitHub project', () => {
    const brief = plannerBrief(GITHUB);

    expect(brief).toContain(
      '- One ticket is one pull request one builder can finish.',
    );
    expect(brief).toContain(
      'Do not edit files, run builds or open pull requests.',
    );
  });
});

describe('crew rules wording', () => {
  let store: Store;
  let homeDir = '';

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
    homeDir = await mkdtemp(resolve(tmpdir(), 'quarterdeck-terms-'));
  });

  afterAll(async () => {
    await store.close();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('gives a GitLab crew a charter and reviewer brief in merge request terms', async () => {
    const rules = crewRules(store, homeDir, async () => 'gitlab');
    const charter = await rules.load('charter');
    const reviewer = await rules.load('reviewer');

    expect(charter).toContain('merged merge requests');
    expect(reviewer).toContain('Every merge request in the project');
    expect(charter).not.toMatch(PULL_TERMS);
    expect(reviewer).not.toMatch(PULL_TERMS);
  });

  it('leaves a GitHub crew its pull requests', async () => {
    const rules = crewRules(store, homeDir, async () => 'github');

    expect(await rules.load('charter')).toContain('merged pull requests');
    expect(await rules.load('reviewer')).toContain(
      'Every pull request in the project',
    );
  });
});

describe('bus tools', () => {
  const texts = (tools: Awaited<ReturnType<typeof loadBusTools>>): string[] =>
    tools.flatMap((tool) => [
      tool.description,
      ...Object.values(tool.input).map((schema) => {
        if (!(schema instanceof z.ZodType)) return '';
        return schema.description ?? '';
      }),
    ]);

  it('describe report and verdict in merge request terms for GitLab', async () => {
    const tools = wordedTools(await loadBusTools(), GITLAB);
    const report = tools.find((tool) => tool.name === 'report');

    expect(report?.description).toContain(
      'Report the merge request for a ticket assigned to you.',
    );
    expect(texts(tools).join('\n')).not.toMatch(PULL_TERMS);
  });

  it('leave the GitHub descriptions as they are', async () => {
    const tools = await loadBusTools();

    expect(texts(wordedTools(tools, GITHUB))).toEqual(texts(tools));
  });
});
