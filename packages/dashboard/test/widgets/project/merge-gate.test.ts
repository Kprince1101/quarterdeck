import { describe, expect, it } from 'vitest';
import {
  gateLayer,
  gateToggles,
  lifecycleRule,
  needsConfirm,
} from '../../../src/widgets/project/merge-gate.js';
import { REPO, ruleView, rulesView } from '../../rules/fixtures.js';

const lifecycle = (machine = '{}', repo?: string) => {
  if (repo === undefined) return ruleView('lifecycle', { machine });
  return ruleView('lifecycle', { machine, repo }, REPO);
};

const checkedOf = (rule: ReturnType<typeof lifecycle>) =>
  gateToggles(rule).toggles.map(({ key, checked, pinnedByRepo }) => [
    key,
    checked,
    pinnedByRepo,
  ]);

describe('merge gate toggles', () => {
  it('finds the lifecycle rule in a rules view', () => {
    expect(lifecycleRule(rulesView()).name).toBe('lifecycle');
    expect(() => lifecycleRule({ ...rulesView(), rules: [] })).toThrow(
      'The lifecycle rule is missing',
    );
  });

  it('labels both toggles as applying to all projects', () => {
    expect(gateToggles(lifecycle()).toggles.map(({ label }) => label)).toEqual([
      'AI review (all projects)',
      'Auto-merge (all projects)',
    ]);
  });

  it('asks before turning auto-merge on, and only then', () => {
    expect(needsConfirm('autoMerge', true)).toBe(true);
    expect(needsConfirm('autoMerge', false)).toBe(false);
    expect(needsConfirm('requireAiReview', true)).toBe(false);
    expect(needsConfirm('requireAiReview', false)).toBe(false);
  });

  it('reads the effective values from defaults, machine and repo layers', () => {
    expect(checkedOf(lifecycle())).toEqual([
      ['requireAiReview', false, false],
      ['autoMerge', false, false],
    ]);
    expect(
      checkedOf(lifecycle('{"mergeGate":{"autoMerge":true}}', '{}')),
    ).toEqual([
      ['requireAiReview', false, false],
      ['autoMerge', true, false],
    ]);
    expect(
      checkedOf(
        lifecycle(
          '{"mergeGate":{"autoMerge":true}}',
          '{"mergeGate":{"requireAiReview":true,"autoMerge":false}}',
        ),
      ),
    ).toEqual([
      ['requireAiReview', true, true],
      ['autoMerge', false, true],
    ]);
  });

  it('writes a fresh machine layer when there is none', () => {
    const absent = ruleView('lifecycle');
    expect(absent.machine.content).toBeNull();
    expect(JSON.parse(gateLayer(absent, 'autoMerge', true))).toEqual({
      mergeGate: { autoMerge: true },
    });
  });

  it('sets only the one key to the value asked for and keeps the rest of the layer', () => {
    const machine = JSON.stringify({
      stuckAfterMinutes: 45,
      budget: { maxTokensPerTicket: 10 },
      mergeGate: { requireAiReview: true, base: 'main' },
    });
    const content = gateLayer(lifecycle(machine), 'requireAiReview', false);
    expect(content.endsWith('\n')).toBe(true);
    expect(JSON.parse(content)).toEqual({
      stuckAfterMinutes: 45,
      budget: { maxTokensPerTicket: 10 },
      mergeGate: { requireAiReview: false, base: 'main' },
    });
    expect(
      JSON.parse(gateLayer(lifecycle(machine), 'requireAiReview', true))
        .mergeGate,
    ).toEqual({ requireAiReview: true, base: 'main' });
  });

  it('reads the deprecated requireCopilotReview as the AI review toggle', () => {
    expect(
      checkedOf(lifecycle('{"mergeGate":{"requireCopilotReview":true}}')),
    ).toEqual([
      ['requireAiReview', true, false],
      ['autoMerge', false, false],
    ]);
    expect(
      checkedOf(lifecycle('{}', '{"mergeGate":{"requireCopilotReview":true}}')),
    ).toEqual([
      ['requireAiReview', true, true],
      ['autoMerge', false, false],
    ]);
  });

  it('renames the deprecated key when it writes the machine layer', () => {
    const machine = '{"mergeGate":{"requireCopilotReview":true}}';
    expect(
      JSON.parse(gateLayer(lifecycle(machine), 'requireAiReview', false)),
    ).toEqual({ mergeGate: { requireAiReview: false } });
    expect(
      JSON.parse(gateLayer(lifecycle(machine), 'autoMerge', true)),
    ).toEqual({ mergeGate: { requireAiReview: true, autoMerge: true } });
  });

  it('refuses a key the repo layer pins or a machine layer it cannot read', () => {
    const pinned = lifecycle('{}', '{"mergeGate":{"requireAiReview":true}}');
    expect(() => gateLayer(pinned, 'requireAiReview', false)).toThrow(
      'pinned by this project',
    );
    expect(() => gateLayer(lifecycle('{'), 'autoMerge', true)).toThrow();
    expect(gateToggles(lifecycle('[]')).toggles).toEqual([]);
  });
});
