import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Naming } from '@quarterdeck/rules';
import type { Store } from '../../src/store/index.js';
import {
  NamesExhaustedError,
  liveAgentNames,
  pickAgentName,
  withNameLock,
} from '../../src/agents/index.js';
import { TIMEOUT, clearAgents, openTestStore } from './fixtures.js';

const NAMING: Naming = { theme: 'birds', names: ['crane', 'egret', 'heron'] };

describe('pickAgentName', () => {
  it('picks among the names no live agent holds', () => {
    const taken = new Set(['crane']);
    expect(pickAgentName(NAMING, taken, () => 0)).toBe('egret');
    expect(pickAgentName(NAMING, taken, () => 0.99)).toBe('heron');
  });

  it('throws when every name in the theme is taken', () => {
    const taken = new Set(NAMING.names);
    expect(() => pickAgentName(NAMING, taken)).toThrow(NamesExhaustedError);
    expect(() => pickAgentName(NAMING, taken)).toThrow(
      'Every birds name is taken by a live agent',
    );
  });
});

describe('withNameLock', () => {
  it('runs claims one at a time and survives a failed claim', async () => {
    const order: string[] = [];
    const claim = (label: string, fail = false) =>
      withNameLock(async () => {
        order.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${label}:end`);
        if (fail) throw new Error(label);
        return label;
      });

    const results = await Promise.allSettled([
      claim('a'),
      claim('b', true),
      claim('c'),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(order).toEqual([
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'c:start',
      'c:end',
    ]);
  });
});

describe('liveAgentNames', () => {
  let deck: Store;
  let yard: Store;

  beforeAll(async () => {
    [deck, yard] = await Promise.all([
      openTestStore('deck'),
      openTestStore('yard'),
    ]);
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all([deck.close(), yard.close()]);
  });

  afterEach(async () => {
    await Promise.all([clearAgents(deck), clearAgents(yard)]);
  });

  const insertAgent = (store: Store, name: string, status: string) =>
    store.db.query(
      `insert into agents (project_id, name, role, status)
       values ($1, $2, 'builder', $3)`,
      [store.projectId, name, status],
    );

  it('collects live names across projects and skips retired agents', async () => {
    await insertAgent(deck, 'crane', 'working');
    await insertAgent(deck, 'egret', 'retired');
    await insertAgent(yard, 'heron', 'paused');

    expect(await liveAgentNames([deck, yard])).toEqual(
      new Set(['crane', 'heron']),
    );
  });

  it('frees the names held in an archived project', async () => {
    await insertAgent(deck, 'crane', 'idle');
    await insertAgent(yard, 'heron', 'idle');
    await yard.db.query('update projects set archived_at = now()');

    expect(await liveAgentNames([deck, yard])).toEqual(new Set(['crane']));
  });

  it('lets a project reuse a name only once its holder is retired', async () => {
    await insertAgent(deck, 'crane', 'retired');
    await insertAgent(deck, 'crane', 'idle');

    await expect(insertAgent(deck, 'crane', 'stuck')).rejects.toThrow(
      /agents_live_name/,
    );
  });
});
