import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startAutoEnd, type AutoEnd } from '../../src/voyage-end/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  fakeScheduler,
  insertAgent,
  insertVoyage,
  insertTicket,
} from './fixtures.js';

const SETTLE_SECONDS = 120;
const HOME = join(tmpdir(), 'qd-stuck-agent-home-never-created');

describe('auto-end with a stuck agent', { timeout: TIMEOUT }, () => {
  let store: Store;

  beforeAll(async () => {
    store = await openStore({ project: 'example', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it('never ends the voyage while an agent is stuck, and settles once it is not', async () => {
    const scheduler = fakeScheduler();
    const ended: string[] = [];
    const errors: unknown[] = [];
    const voyageId = await insertVoyage(store, 1);
    await insertTicket(store, 'done');
    await insertAgent(store, { name: 'driver-1', role: 'driver', voyageId });
    const stuckId = await insertAgent(store, {
      name: 'builder-1',
      status: 'stuck',
      voyageId,
    });
    const auto: AutoEnd = await startAutoEnd({
      store,
      voyageId,
      settleSeconds: SETTLE_SECONDS,
      schedule: scheduler.schedule,
      home: HOME,
      end: async (id) => {
        ended.push(id);
      },
      onError: (err) => {
        errors.push(err);
      },
    });
    try {
      await auto.check();
      expect(scheduler.timers).toEqual([]);
      expect(ended).toEqual([]);

      await store.db.query(`update agents set status = 'idle' where id = $1`, [
        stuckId,
      ]);

      await vi.waitFor(() => {
        expect(scheduler.live()).toHaveLength(1);
      });
    } finally {
      await auto.close();
    }
    expect(errors).toEqual([]);
  });
});
