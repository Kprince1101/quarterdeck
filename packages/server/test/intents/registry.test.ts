import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_NAMES } from '@quarterdeck/rules';
import {
  DATA_PAGE_SIZE,
  INTENTS,
  INTENT_NAMES,
  MAX_DATA_PAGE_SIZE,
  intentPath,
  isIntentName,
  ruleNameSchema,
} from '@quarterdeck/server/intents';
import { INTENT_HANDLERS } from '../../src/api/index.js';

const INTENTS_DIR = resolve(import.meta.dirname, '../../src/intents');
const BROWSER_SAFE_IMPORT = /^(zod|@quarterdeck\/rules\/schemas|\.\.?\/)/;
const GLOBAL_INTENTS = new Set(['rules.write', 'rules.reset', 'wipe.all']);

const importsOf = (source: string): string[] =>
  [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');

describe('intent registry', () => {
  it('covers every intent area the dashboard sends', () => {
    const areas = new Set(INTENT_NAMES.map((name) => name.split('.')[0]));
    expect([...areas].toSorted()).toEqual(
      [
        'agent',
        'card',
        'charter',
        'data',
        'layout',
        'notebook',
        'pause',
        'planner',
        'project',
        'round',
        'rules',
        'ticket',
        'turn',
        'usage',
        'wipe',
      ].toSorted(),
    );
  });

  it('has a server handler for every intent and nothing else', () => {
    expect(Object.keys(INTENT_HANDLERS).toSorted()).toEqual(
      [...INTENT_NAMES].toSorted(),
    );
  });

  it('names rules exactly as the rules loader does', () => {
    expect(ruleNameSchema.options).toEqual(RULE_NAMES);
  });

  it('scopes every intent but machine rules and wipe.all to a project', () => {
    const unscoped = INTENT_NAMES.filter((name) =>
      INTENTS[name]
        .safeParse({})
        .error?.issues.every((issue) => issue.path[0] !== 'project'),
    );
    expect(new Set(unscoped)).toEqual(GLOBAL_INTENTS);
  });

  it('resolves names and paths', () => {
    expect(isIntentName('card.answer')).toBe(true);
    expect(isIntentName('toString')).toBe(false);
    expect(intentPath('wipe.all')).toBe('/api/intents/wipe.all');
  });

  it('only imports modules a browser bundle can load', async () => {
    const files = await readdir(INTENTS_DIR);
    const sources = await Promise.all(
      files.map((file) => readFile(resolve(INTENTS_DIR, file), 'utf8')),
    );
    const imports = sources.flatMap(importsOf);
    expect(imports.filter((from) => !BROWSER_SAFE_IMPORT.test(from))).toEqual(
      [],
    );
    const slug = await readFile(resolve(INTENTS_DIR, '../lib/slug.ts'), 'utf8');
    expect(importsOf(slug)).toEqual([]);
  });
});

describe('intent schemas', () => {
  const project = 'deck';
  const id = crypto.randomUUID();

  it('rejects keys the schema does not know', () => {
    const result = INTENTS['notebook.add'].safeParse({
      project,
      body: 'x',
      author: 'me',
    });
    expect(result.success).toBe(false);
  });

  it('fills defaults the server relies on', () => {
    expect(INTENTS['ticket.create'].parse({ project, title: 'QD6a' })).toEqual({
      project,
      title: 'QD6a',
      body: '',
      dependsOn: [],
    });
    expect(INTENTS['notebook.add'].parse({ project, body: 'x' })).toEqual({
      project,
      body: 'x',
      pinned: false,
    });
  });

  it('refuses updates that change nothing', () => {
    expect(
      INTENTS['ticket.update'].safeParse({ project, ticketId: id }).success,
    ).toBe(false);
    expect(INTENTS['project.update'].safeParse({ project }).success).toBe(
      false,
    );
    expect(
      INTENTS['project.update'].safeParse({ project, repoPath: null }).success,
    ).toBe(true);
  });

  it('requires absolute repo paths and repeated dependencies once', () => {
    expect(
      INTENTS['project.create'].safeParse({ project, repoPath: 'relative' })
        .success,
    ).toBe(false);
    expect(
      INTENTS['ticket.create'].safeParse({
        project,
        title: 't',
        dependsOn: [id, id],
      }).success,
    ).toBe(false);
  });

  it('keeps machine rules free of a project and project rules tied to one', () => {
    expect(
      INTENTS['rules.write'].safeParse({
        scope: 'machine',
        name: 'charter',
        content: '# c',
      }).success,
    ).toBe(true);
    expect(
      INTENTS['rules.write'].safeParse({
        scope: 'project',
        name: 'charter',
        content: '# c',
      }).success,
    ).toBe(false);
    expect(
      INTENTS['rules.reset'].safeParse({ scope: 'machine', name: 'other' })
        .success,
    ).toBe(false);
  });

  it('pages data rows within bounds', () => {
    expect(INTENTS['data.rows'].parse({ project, table: 'events' })).toEqual({
      project,
      table: 'events',
      offset: 0,
      limit: DATA_PAGE_SIZE,
    });
    [
      { table: 'events', limit: MAX_DATA_PAGE_SIZE + 1 },
      { table: 'events', limit: 0 },
      { table: 'events', offset: -1 },
      { table: 'events; drop table events' },
      { table: 'Events' },
    ].forEach((input) =>
      expect(
        INTENTS['data.rows'].safeParse({ project, ...input }).success,
      ).toBe(false),
    );
  });

  it('validates layout grids', () => {
    const item = { id: 'a', widget: 'board', x: 0, y: 0, w: 0, h: 1 };
    expect(
      INTENTS['layout.save'].safeParse({
        project,
        name: 'n',
        spec: { columns: 12, items: [item] },
      }).success,
    ).toBe(false);
  });
});
