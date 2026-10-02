import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROCESS_SWEPT_EVENT } from '../../src/agents/index.js';
import { recoverProject } from '../../src/lifecycle/index.js';
import type { Store } from '../../src/store/index.js';
import { giveProcess, storedPid } from '../lifecycle/fixtures.js';
import { eventPayloads, insertAgent } from '../round-end/fixtures.js';
import { TIMEOUT, openTestStore } from './fixtures.js';

vi.mock('../../src/acp/client/process-start.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/acp/client/process-start.js')
  >()),
  stopOwnTree: () => Promise.resolve('unverified'),
}));

describe('a sweep that cannot check the process', { timeout: TIMEOUT }, () => {
  let store: Store;

  beforeAll(async () => {
    store = await openTestStore('deck');
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it('keeps the recorded pid so the next restart tries again', async () => {
    const agentId = await insertAgent(store, { name: 'wren' });
    await giveProcess(store, agentId, { pid: 4242, startedAt: new Date() });

    const first = await recoverProject(store);
    const again = await recoverProject(store);

    expect(first.reaped).toEqual([
      { agentId, name: 'wren', outcome: 'unverified' },
    ]);
    expect(again.reaped).toEqual(first.reaped);
    expect(await storedPid(store, agentId)).toBe(4242);
    expect(await eventPayloads(store, PROCESS_SWEPT_EVENT)).toEqual([
      { name: 'wren', pid: 4242, reason: 'restart', outcome: 'unverified' },
      { name: 'wren', pid: 4242, reason: 'restart', outcome: 'unverified' },
    ]);
  });
});
