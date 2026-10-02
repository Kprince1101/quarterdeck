import { RULE_NAMES } from '@quarterdeck/rules';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RulesReadError,
  createRulesReader,
  type RulesReader,
} from '../../src/api/index.js';
import { TIMEOUT, startDeck, type Deck } from './harness.js';

const caught = async (promise: Promise<unknown>): Promise<RulesReadError> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RulesReadError) return err;
    throw err;
  }
  throw new Error('expected a RulesReadError');
};

const replyWith = (status: number, body: string) =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status })));

describe('rules reader', { timeout: TIMEOUT }, () => {
  let deck: Deck;
  let read: RulesReader;

  beforeAll(async () => {
    deck = await startDeck('deck');
    read = createRulesReader({ baseUrl: deck.api.url });
  }, TIMEOUT);

  afterAll(async () => {
    await deck.close();
  });

  it('reads every rule layer for the machine and for a project', async () => {
    const machine = await read(null);
    expect(machine.project).toBeNull();
    expect(machine.rules.map(({ name }) => name)).toEqual(RULE_NAMES);
    await deck.client.rules.write({
      scope: 'machine',
      name: 'models',
      content: '{ "builder": { "runtime": "claude" } }',
    });
    const project = await read('deck');
    expect(project.project).toBe('deck');
    expect(
      project.rules.find(({ name }) => name === 'models')?.machine.content,
    ).toBe('{ "builder": { "runtime": "claude" } }');
  });

  it('throws the server error for an unknown project', async () => {
    const err = await caught(read('missing'));
    expect(err.status).toBe(404);
    expect(err.message).toBe('project missing does not exist');
  });

  it('refuses a malformed or unreadable reply', async () => {
    const malformed = createRulesReader({ fetch: replyWith(200, '{}') });
    expect((await caught(malformed(null))).message).toBe(
      'The rules reply is malformed',
    );
    const broken = createRulesReader({ fetch: replyWith(500, 'oops') });
    expect((await caught(broken(null))).message).toBe(
      'Reading the rules failed with HTTP 500',
    );
  });

  it('asks the page origin for /api/rules with the project as a query', async () => {
    const fetch = replyWith(500, '');
    await caught(createRulesReader({ fetch })('deck'));
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/rules?project=deck');
  });
});
