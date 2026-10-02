import { describe, expect, it } from 'vitest';
import {
  IN_MEMORY,
  assertServerVersion,
  openStore,
  type Queryable,
} from '../../src/store/index.js';

const serverAt = (num: number, version: string): Queryable => ({
  query: <T>() => Promise.resolve({ rows: [{ num, version }] as T[] }),
  exec: () => Promise.resolve(),
});

describe('assertServerVersion', () => {
  it.each([
    [150_000, '15.0'],
    [170_006, '17.6'],
  ])('accepts server_version_num %i', async (num, version) => {
    await expect(
      assertServerVersion(serverAt(num, version)),
    ).resolves.toBeUndefined();
  });

  it('rejects Postgres 14 and names the version it found', async () => {
    await expect(
      assertServerVersion(serverAt(140_019, '14.19')),
    ).rejects.toThrow(
      'Quarterdeck needs Postgres 15 or newer; this server is Postgres 14.19',
    );
  });

  it('accepts the PGlite build', async () => {
    const store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
    await expect(assertServerVersion(store.db)).resolves.toBeUndefined();
    await store.close();
  }, 30_000);
});
