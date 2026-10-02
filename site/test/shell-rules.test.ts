import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PermissionLayers } from '@quarterdeck/rules';
import { decidePermission } from '@quarterdeck/server';
import { describe, expect, it } from 'vitest';
import { ROOT, pageText, readPage } from './pages.js';

interface Example {
  pattern: string;
  command: string;
  allowed: boolean;
}

const REPO_DIR = resolve('/work/example');

const ANSWERS: Record<string, boolean> = { yes: true, no: false };

const example = (cells: string[]): Example => {
  const [pattern = '', command = '', answer = ''] = cells;
  const allowed = ANSWERS[answer];
  if (allowed === undefined) throw new Error(`not yes or no: ${answer}`);
  return { pattern, command, allowed };
};

const readmeSection = (): string => {
  const readme = readFileSync(resolve(ROOT, 'rules/README.md'), 'utf8');
  return /## Shell permissions\n([\s\S]*?)(?=\n## |$)/.exec(readme)?.[1] ?? '';
};

const readmeExamples = (): Example[] =>
  [
    ...readmeSection().matchAll(/^\| `([^`]+)` +\| `([^`]+)` +\| (\w+) +\|$/gm),
  ].map((match) => example(match.slice(1)));

const siteExamples = (): Example[] => {
  const html = readPage('docs/rules.html');
  const table =
    /<table id="shell-examples">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? '';
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((row) =>
      [...(row[1] ?? '').matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cell) =>
        pageText(cell[1] ?? '').trim(),
      ),
    )
    .filter((cells) => cells.length > 0)
    .map(example);
};

const allows = ({ pattern, command }: Example): boolean => {
  const layers: PermissionLayers = {
    machine: {
      default: 'ask',
      rules: [{ kind: 'execute', pattern, decision: 'allow' }],
    },
  };
  const request = {
    kind: 'execute' as const,
    cwd: REPO_DIR,
    paths: [],
    command,
  };
  return decidePermission(layers, request, REPO_DIR) === 'allow';
};

describe('documented shell permission examples', () => {
  const readme = readmeExamples();
  const site = siteExamples();

  it('show git * allowing git -c and git status * not', () => {
    expect(readme).toContainEqual({
      pattern: 'git *',
      command: "git -c alias.x='!sh' x",
      allowed: true,
    });
    expect(readme).toContainEqual({
      pattern: 'git status *',
      command: 'git -c core.pager=less status',
      allowed: false,
    });
  });

  it('are the same in the rules README and on the site', () => {
    expect(site).toEqual(readme);
  });

  it.each(readmeExamples())(
    '$pattern against $command: allowed is $allowed',
    (documented) => {
      expect(allows(documented)).toBe(documented.allowed);
    },
  );
});
