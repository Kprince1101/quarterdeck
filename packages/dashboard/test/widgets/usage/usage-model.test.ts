import { describe, expect, it } from 'vitest';
import {
  lastTurnEnd,
  usageLevel,
  usageView,
} from '../../../src/widgets/usage/usage-model.js';
import { at, turn, usage } from './fixtures.js';

describe('usage model', () => {
  it('turns amber at 60% and red at 80%', () => {
    expect(usageLevel(0)).toBe('ok');
    expect(usageLevel(59.99)).toBe('ok');
    expect(usageLevel(60)).toBe('amber');
    expect(usageLevel(79.99)).toBe('amber');
    expect(usageLevel(80)).toBe('red');
    expect(usageLevel(140)).toBe('red');
  });

  it('shows the cap percent rounded down and labels the scope', () => {
    expect(usageView(usage(799_999, 1_000_000))).toEqual({
      usedLabel: '799,999 tokens in the last 5h, this project',
      percentLabel: '79%',
      level: 'amber',
    });
  });

  it('has no percent or level without a cap', () => {
    expect(usageView(usage(3, null))).toEqual({
      usedLabel: '3 tokens in the last 5h, this project',
      percentLabel: null,
      level: null,
    });
  });

  it('uses the window length the server read', () => {
    expect(usageView({ ...usage(1, null), windowHours: 6 }).usedLabel).toBe(
      '1 tokens in the last 6h, this project',
    );
  });

  it('finds the newest turn end, skipping running turns', () => {
    expect(lastTurnEnd([])).toBeNull();
    expect(
      lastTurnEnd([
        turn(1, at(-5)),
        turn(2, null),
        turn(3, at(-2)),
        turn(4, at(-9)),
      ]),
    ).toBe(at(-2));
  });
});
