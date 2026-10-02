import { RulesError } from '@quarterdeck/rules/merge';
import { describe, expect, it } from 'vitest';
import {
  NO_CAP,
  WINDOW_MS,
  buildUsage,
  usageLevel,
  windowCapOf,
  windowTokens,
} from '../../../src/widgets/usage/usage-model.js';
import { HOME, rulesView } from '../../rules/fixtures.js';
import { HOUR, NOW, OTHER_AGENT, ago, turn } from './fixtures.js';

describe('usage model', () => {
  it('sums input and output tokens of every agent’s turns in the last 5h', () => {
    const turns = [
      turn(1, ago(6 * HOUR), 900_000, 100_000),
      turn(2, ago(WINDOW_MS), 1000, 200),
      turn(3, ago(HOUR), 30, 4, OTHER_AGENT),
      turn(4, ago(WINDOW_MS + 1), 7, 7),
    ];

    expect(windowTokens(turns, NOW)).toBe(1234);
  });

  it('turns amber at 60% and red at 80%', () => {
    expect(usageLevel(0)).toBe('ok');
    expect(usageLevel(59.99)).toBe('ok');
    expect(usageLevel(60)).toBe('amber');
    expect(usageLevel(79.99)).toBe('amber');
    expect(usageLevel(80)).toBe('red');
    expect(usageLevel(140)).toBe('red');
  });

  it('shows the cap percent, rounded down, beside the token total', () => {
    const usage = buildUsage(
      [turn(1, ago(HOUR), 600_000, 199_999)],
      1_000_000,
      NOW,
    );

    expect(usage).toMatchObject({
      tokens: 799_999,
      tokensLabel: '799,999 tokens in the last 5h',
      percentLabel: '79%',
      level: 'amber',
    });
    expect(usage.percent).toBeCloseTo(79.9999);
  });

  it('shows only the token total without a cap', () => {
    const usage = buildUsage([turn(1, ago(HOUR), 1, 2)], null, NOW);

    expect(usage).toEqual({
      tokens: 3,
      tokensLabel: '3 tokens in the last 5h',
      percent: null,
      percentLabel: null,
      level: null,
    });
    expect(NO_CAP).toBe('No cap set');
  });

  it('has no window cap in the shipped defaults', () => {
    expect(windowCapOf(rulesView())).toBeNull();
  });

  it('reads the window cap from the machine layer', () => {
    const view = rulesView({
      lifecycle: { machine: '{ "usage": { "windowCapTokens": 4000000 } }' },
    });

    expect(windowCapOf(view)).toBe(4_000_000);
  });

  it('ignores a cap set in a repo layer', () => {
    const view = rulesView(
      { lifecycle: { repo: '{ "usage": { "windowCapTokens": 10 } }' } },
      '/work/deck',
    );

    expect(windowCapOf(view)).toBeNull();
  });

  it('refuses a machine layer that is not valid', () => {
    const path = `${HOME}/rules.local.lifecycle.json`;

    expect(() =>
      windowCapOf(
        rulesView({
          lifecycle: { machine: '{ "usage": { "windowCapTokens": 0 } }' },
        }),
      ),
    ).toThrow(RulesError);
    expect(() =>
      windowCapOf(rulesView({ lifecycle: { machine: '{ nope' } })),
    ).toThrow(path);
  });
});
