import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  LOCAL_RULES_DIR,
  LOCAL_RULES_PREFIX,
  RULE_FILES,
  lifecycleSchema,
  runtimeSchema,
} from '@quarterdeck/rules';
import {
  TURN_FILES,
  dataPaths,
  projectDataDir,
  projectTurnsDir,
  projectWorktreesDir,
  quarterdeckHome,
} from '@quarterdeck/server';
import { DOCTOR_FIXES, INIT_USAGE, UP_USAGE, USAGE } from 'quarterdeck';
import { describe, expect, it } from 'vitest';
import {
  ROOT,
  codeBlocks,
  headings,
  htmlPages,
  pageText,
  readPage,
} from './pages.js';

const DOCS = [
  'quickstart.html',
  'rules.html',
  'widgets.html',
  'data.html',
  'faq.html',
];

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as unknown;

const readDoc = (page: string): string => readPage(`docs/${page}`);

const indexOfHeading = (titles: string[], word: string): number =>
  titles.findIndex((title) => title.includes(word));

const tableCells = (html: string): Map<string, string> =>
  new Map(
    [
      ...html.matchAll(
        /<td>\s*<code>([\w.]+)<\/code>\s*<\/td>\s*<td>\s*(?:<code>)?([^<]*?)(?:<\/code>)?\s*<\/td>/g,
      ),
    ].map((match) => [match[1] ?? '', match[2] ?? '']),
  );

const shownDefault = (value: unknown): string => {
  if (value === undefined) return 'unset';
  return JSON.stringify(value);
};

describe('docs', () => {
  it('ships exactly the docs pages', () => {
    const pages = htmlPages.filter((page) => page.startsWith('docs'));
    expect(pages.map((page) => basename(page)).toSorted()).toEqual(
      DOCS.toSorted(),
    );
  });

  it.each(DOCS)(
    '%s links home and to every docs page, itself current',
    (page) => {
      const html = readDoc(page);
      const nav = /<nav[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? '';

      expect([...nav.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([
        '../',
        ...DOCS,
      ]);
      expect(nav).toContain(`<a href="${page}" aria-current="page">`);
    },
  );

  it('every npx quarterdeck command is one the cli has', () => {
    const commands = DOCS.flatMap((page) => [
      ...pageText(readDoc(page)).matchAll(/npx quarterdeck (\w+)/g),
    ]).map((match) => match[1]);

    expect(new Set(commands)).toEqual(new Set(['doctor', 'init', 'up']));
    commands.forEach((command) => expect(USAGE).toContain(`\n  ${command} `));
  });
});

describe('quickstart', () => {
  const html = readDoc('quickstart.html');
  const code = codeBlocks(html).join('\n');

  it('goes Kiro, then Claude Code, then Gemini', () => {
    const titles = headings(html, 2);
    const order = ['Kiro', 'Claude Code', 'Gemini'].map((word) =>
      indexOfHeading(titles, word),
    );

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it.each(Object.entries(DOCTOR_FIXES).filter(([key]) => key !== 'node'))(
    'shows the command doctor prints for %s',
    (_key, command) => {
      expect(code).toContain(`: ${command}`);
    },
  );

  it('shows the runtime prompt init asks', () => {
    const models = readJson('rules/models.json') as {
      driver: { runtime: string };
    };
    const runtimes = runtimeSchema.options.join(', ');

    expect(code).toContain(
      `Runtime (${runtimes}) [${models.driver.runtime}]: `,
    );
  });

  it('names only flags init and up take', () => {
    const flags = [...html.matchAll(/<code>(--[a-z-]+)/g)].map((m) => m[1]);

    expect(flags.length).toBeGreaterThan(0);
    flags.forEach((flag) =>
      expect(`${INIT_USAGE}\n${UP_USAGE}`).toContain(`${flag} `),
    );
  });
});

describe('rules page', () => {
  const html = readDoc('rules.html');
  const text = pageText(html);

  it.each(Object.values(RULE_FILES))('documents %s', (file) => {
    expect(html).toContain(`<code>${file}</code>`);
  });

  it('names the local layer files', () => {
    expect(text).toContain(`~/.quarterdeck/${LOCAL_RULES_PREFIX}<file>`);
    expect(text).toContain(
      `<repo>/${LOCAL_RULES_DIR}/${LOCAL_RULES_PREFIX}<file>`,
    );
  });

  it('shows the shipped permission defaults', () => {
    const blocks = codeBlocks(html)
      .filter((block) => block.startsWith('{'))
      .map((block) => JSON.parse(block) as unknown);

    expect(blocks).toContainEqual(readJson('rules/permissions.json'));
  });

  it('lists every lifecycle key with its shipped default', () => {
    const lifecycle = readJson('rules/lifecycle.json') as {
      budget: Record<string, unknown>;
      mergeGate: Record<string, unknown>;
    } & Record<string, unknown>;
    const cells = tableCells(html);
    const expected = [
      ...Object.keys(lifecycleSchema.shape)
        .filter((key) => key !== 'budget' && key !== 'mergeGate')
        .map((key) => [key, lifecycle[key]]),
      ...Object.keys(lifecycleSchema.shape.budget.shape).map((key) => [
        `budget.${key}`,
        lifecycle.budget[key],
      ]),
      ...Object.keys(lifecycleSchema.shape.mergeGate.shape).map((key) => [
        key,
        lifecycle.mergeGate[key],
      ]),
    ];

    expected.forEach(([key, value]) =>
      expect(cells.get(String(key)), String(key)).toBe(shownDefault(value)),
    );
  });
});

describe('widgets page', () => {
  it('has one section per widget in the SPEC, in order', () => {
    const spec = readFileSync(resolve(ROOT, 'SPEC.md'), 'utf8');
    const widgets = /Widgets: ([^.]+)\./.exec(spec)?.[1]?.split(', ');

    expect(widgets).toBeDefined();
    expect(headings(readDoc('widgets.html'), 2)).toEqual(widgets);
  });

  it('shows no screenshots', () => {
    expect(readDoc('widgets.html')).not.toMatch(/<img|<figure/);
  });
});

describe('data page', () => {
  const text = pageText(readDoc('data.html'));
  const home = quarterdeckHome('~');
  const shown = (path: string) =>
    `${path.replace('/project/', '/<project>/')}/`;

  it.each([
    ['data dir', projectDataDir('project', home)],
    ['turns dir', projectTurnsDir('project', home)],
    ['worktrees dir', projectWorktreesDir('project', home)],
  ])('names the %s', (_name, path) => {
    expect(text).toContain(shown(path));
  });

  it.each(Object.values(TURN_FILES))('names the turn file %s', (file) => {
    expect(text).toContain(file);
  });

  it('names the machine and repo rule layers', () => {
    expect(text).toContain(`${home}/${LOCAL_RULES_PREFIX}<file>`);
    expect(text).toContain(
      `<repo>/${LOCAL_RULES_DIR}/${LOCAL_RULES_PREFIX}<file>`,
    );
  });

  it.each(
    dataPaths({ homeDir: '/home/me', project: 'project', repoPath: '/repo' }),
  )('names $label ($scope) as the Data widget lists it', ({ path, kind }) => {
    const documented = path
      .replace(/^\/home\/me/, '~')
      .replace(/^\/repo/, '<repo>')
      .replace('/project/', '/<project>/')
      .replace(/rules\.local\.[^/]+$/, `${LOCAL_RULES_PREFIX}<file>`);
    const suffix: Record<typeof kind, string> = {
      directory: '/',
      file: '',
      database: '',
    };
    expect(text).toContain(`${documented}${suffix[kind]}`);
  });
});
