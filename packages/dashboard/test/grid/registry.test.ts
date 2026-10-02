import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  defineWidget,
  definitionsFrom,
} from '../../src/widgets/registry.js';
import { WIDGETS } from '../../src/widgets/widgets.js';
import { ALPHA, BETA } from './fixtures.js';

describe('widget registry', () => {
  it('discovers every *.widget.tsx file', () => {
    expect([...WIDGETS.keys()]).toEqual(['events', 'planner', 'tables']);
    expect(WIDGETS.get('events')?.title).toBe('Events');
  });

  it('keys definitions by type', () => {
    const registry = createRegistry([ALPHA, BETA]);
    expect(registry.get('beta')).toBe(BETA);
  });

  it('refuses a type registered twice', () => {
    expect(() => createRegistry([ALPHA, ALPHA])).toThrow(
      'widget alpha is registered twice',
    );
  });

  it('refuses a type that is not kebab-case', () => {
    expect(() => createRegistry([{ ...ALPHA, type: 'Alpha Widget' }])).toThrow(
      'not kebab-case',
    );
  });

  it('refuses a default size under the minimum', () => {
    const small = defineWidget({ ...ALPHA, size: { w: 1, h: 4 } });
    expect(() => createRegistry([small])).toThrow('smaller than its minSize');
    const zero = defineWidget({ ...ALPHA, minSize: { w: 0, h: 1 } });
    expect(() => createRegistry([zero])).toThrow('minSize under 1');
  });

  it('reads modules in path order and names a file that exports nothing', () => {
    expect(
      definitionsFrom({
        './b.widget.tsx': { default: BETA },
        './a.widget.tsx': { default: ALPHA },
      }),
    ).toEqual([ALPHA, BETA]);
    expect(() => definitionsFrom({ './c.widget.tsx': {} })).toThrow(
      './c.widget.tsx must export default defineWidget({...})',
    );
  });
});
