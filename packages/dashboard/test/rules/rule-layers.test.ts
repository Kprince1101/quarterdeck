import { describe, expect, it } from 'vitest';
import {
  checkDraft,
  initialDraft,
  valueSources,
} from '../../src/widgets/rules/rule-layers.js';
import { REPO, ruleView } from './fixtures.js';

const sourcesOf = (rule: ReturnType<typeof ruleView>, draft: string) => {
  const check = checkDraft(rule, draft);
  return Object.fromEntries(
    valueSources(rule, check, draft).map(({ key, layer }) => [key, layer]),
  );
};

describe('checkDraft', () => {
  it('accepts a partial JSON override that merges over the defaults', () => {
    const rule = ruleView('lifecycle');
    const check = checkDraft(rule, '{ "stuckAfterMinutes": 45 }');
    expect(check.error).toBeNull();
    expect(check.merged).toMatchObject({
      stuckAfterMinutes: 45,
      autoEndSettleSeconds: 120,
    });
  });

  it('refuses what the loader refuses, naming the machine file', () => {
    const rule = ruleView('naming');
    const unknownKey = checkDraft(rule, '{ "nams": [] }');
    expect(unknownKey.error).toContain(rule.machine.path);
    expect(unknownKey.error).toContain('nams');
    expect(checkDraft(rule, '{ "names": ["a", "a"] }').error).toContain(
      'names must be unique',
    );
    expect(checkDraft(rule, '{').error).toContain(rule.machine.path);
  });

  it('refuses an empty markdown override', () => {
    const rule = ruleView('reviewer');
    expect(checkDraft(rule, '   \n').error).toContain(rule.machine.path);
    expect(checkDraft(rule, '# Reviewer\n').error).toBeNull();
  });

  it('applies the repo layer on top, read-only, without blocking the save', () => {
    const rule = ruleView(
      'lifecycle',
      { repo: '{ "mergeGate": { "base": "release" } }' },
      REPO,
    );
    const check = checkDraft(rule, '{}');
    expect(check.error).toBeNull();
    expect(check.repoError).toContain('may only tighten the merge gate');
    expect(check.repoError).toContain(rule.repo?.path);
  });

  it('checks repo permissions on their own and never merges them', () => {
    const loosening = ruleView(
      'permissions',
      { repo: '{ "default": "allow" }' },
      REPO,
    );
    expect(checkDraft(loosening, '{}').repoError).toContain(
      'may only tighten permissions',
    );
    const tightening = ruleView(
      'permissions',
      { repo: '{ "default": "deny" }' },
      REPO,
    );
    const check = checkDraft(tightening, '{}');
    expect(check.repoError).toBeNull();
    expect(check.effective).toMatchObject({ default: 'ask' });
  });
});

describe('initialDraft', () => {
  it('starts from the machine file, the markdown defaults or an empty object', () => {
    expect(initialDraft(ruleView('models', { machine: '{"a":1}' }))).toBe(
      '{"a":1}',
    );
    const charter = ruleView('charter');
    expect(initialDraft(charter)).toBe(charter.defaults.content);
    expect(initialDraft(ruleView('models'))).toBe('{}\n');
  });
});

describe('valueSources', () => {
  it('says which layer each value comes from', () => {
    const rule = ruleView(
      'lifecycle',
      { repo: '{ "stuckAfterMinutes": 60 }' },
      REPO,
    );
    expect(sourcesOf(rule, '{ "budget": { "warnAtFraction": 0.5 } }')).toEqual({
      autoEndSettleSeconds: 'defaults',
      stuckAfterMinutes: 'repo',
      'budget.maxTokensPerTicket': 'defaults',
      'budget.warnAtFraction': 'machine',
      'mergeGate.requireReviewerApproval': 'defaults',
      'mergeGate.requireChecksPassing': 'defaults',
      'mergeGate.requireCopilotReview': 'defaults',
      'mergeGate.autoMerge': 'defaults',
    });
  });

  it('credits the repo layer for a merge gate only where it tightened it', () => {
    const rule = ruleView(
      'lifecycle',
      {
        repo: '{ "mergeGate": { "requireCopilotReview": true, "autoMerge": true } }',
      },
      REPO,
    );
    const sources = sourcesOf(rule, '{ "mergeGate": { "autoMerge": false } }');
    expect(sources['mergeGate.requireCopilotReview']).toBe('repo');
    expect(sources['mergeGate.autoMerge']).toBe('machine');
  });

  it('marks the values the repo layer can only tighten', () => {
    const rule = ruleView('lifecycle');
    const check = checkDraft(rule, '{}');
    const tight = valueSources(rule, check, '{}')
      .filter(({ tightenOnly }) => tightenOnly)
      .map(({ key }) => key);
    expect(tight).toEqual([
      'mergeGate.requireReviewerApproval',
      'mergeGate.requireChecksPassing',
      'mergeGate.requireCopilotReview',
      'mergeGate.autoMerge',
    ]);
    const permissions = ruleView('permissions');
    expect(
      valueSources(permissions, checkDraft(permissions, '{}'), '{}').every(
        ({ tightenOnly }) => tightenOnly,
      ),
    ).toBe(true);
  });

  it('keeps arrays whole, since a layer replaces them', () => {
    const rule = ruleView('naming');
    expect(sourcesOf(rule, '{ "names": ["alpha", "bravo"] }')).toEqual({
      theme: 'defaults',
      names: 'machine',
    });
  });

  it('takes a markdown rule whole from its highest layer', () => {
    const plain = ruleView('charter');
    expect(sourcesOf(plain, initialDraft(plain))).toEqual({
      'charter.md': 'defaults',
    });
    expect(sourcesOf(plain, '# Mine')).toEqual({ 'charter.md': 'machine' });
    const repo = ruleView('charter', { repo: '# Repo' }, REPO);
    expect(sourcesOf(repo, '# Mine')).toEqual({ 'charter.md': 'repo' });
  });

  it('lists nothing while the draft is refused', () => {
    const rule = ruleView('models');
    expect(valueSources(rule, checkDraft(rule, '{'), '{')).toEqual([]);
  });
});
