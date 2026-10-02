import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matchesGlob } from '@quarterdeck/server';
import type { GlobMode } from '@quarterdeck/server';
import { SAFE_CHARS } from './arbitraries.ts';

const MODES: readonly GlobMode[] = ['path', 'command'];

const modeArb = fc.constantFrom(...MODES);
const literalArb = fc
  .string()
  .filter((text) => !text.includes('*') && !text.includes('?'));
const segmentArb = fc.string({ unit: fc.constantFrom(...SAFE_CHARS) });

describe('glob matcher', () => {
  it('matches the documented examples', () => {
    expect(matchesGlob('src/**', 'src/a/b.ts', 'path')).toBe(true);
    expect(matchesGlob('src/*', 'src/a.ts', 'path')).toBe(true);
    expect(matchesGlob('src/*', 'src/a/b.ts', 'path')).toBe(false);
    expect(matchesGlob('**/*.ts', 'index.ts', 'path')).toBe(true);
    expect(matchesGlob('**/*.ts', 'src/deep/index.ts', 'path')).toBe(true);
    expect(matchesGlob('**/*.ts', 'src/index.md', 'path')).toBe(false);
    expect(matchesGlob('?.md', 'a.md', 'path')).toBe(true);
    expect(matchesGlob('npm *', 'npm run build', 'command')).toBe(true);
    expect(matchesGlob('rm *', 'rm -rf /var/x', 'command')).toBe(true);
    expect(matchesGlob('npm test', 'npm test --watch', 'command')).toBe(false);
  });

  it('treats a pattern without wildcards as an exact string', () => {
    fc.assert(
      fc.property(
        literalArb,
        fc.string(),
        modeArb,
        (pattern, subject, mode) => {
          expect(matchesGlob(pattern, subject, mode)).toBe(pattern === subject);
          expect(matchesGlob(pattern, pattern, mode)).toBe(true);
        },
      ),
    );
  });

  it('lets ** match any subject in either mode', () => {
    fc.assert(
      fc.property(fc.string(), modeArb, (subject, mode) => {
        expect(matchesGlob('**', subject, mode)).toBe(true);
      }),
    );
  });

  it('keeps a path-mode * inside one segment', () => {
    fc.assert(
      fc.property(segmentArb, segmentArb, (left, right) => {
        expect(matchesGlob('*', left, 'path')).toBe(true);
        expect(matchesGlob('*', `${left}/${right}`, 'path')).toBe(false);
        expect(matchesGlob('*', `${left}/${right}`, 'command')).toBe(true);
      }),
    );
  });

  it('matches every path under a literal prefix with prefix/**', () => {
    fc.assert(
      fc.property(
        fc.array(
          segmentArb.filter((segment) => segment.length > 0),
          {
            minLength: 1,
            maxLength: 3,
          },
        ),
        fc.string(),
        (segments, rest) => {
          const prefix = segments.join('/');
          expect(matchesGlob(`${prefix}/**`, `${prefix}/${rest}`, 'path')).toBe(
            true,
          );
          expect(
            matchesGlob(`${prefix}/**`, `x${prefix}/${rest}`, 'path'),
          ).toBe(false);
        },
      ),
    );
  });

  it('lets **/ match zero or more leading directories', () => {
    fc.assert(
      fc.property(
        fc.array(
          segmentArb.filter((segment) => segment.length > 0),
          {
            maxLength: 3,
          },
        ),
        segmentArb,
        (dirs, name) => {
          const path = [...dirs, `${name}.ts`].join('/');
          expect(matchesGlob('**/*.ts', path, 'path')).toBe(true);
        },
      ),
    );
  });

  it('never throws on arbitrary patterns', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        modeArb,
        (pattern, subject, mode) => {
          expect(typeof matchesGlob(pattern, subject, mode)).toBe('boolean');
        },
      ),
    );
  });
});
