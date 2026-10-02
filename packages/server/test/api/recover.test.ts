import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApiServer, type ApiServer } from '../../src/api/index.js';
import { PAUSE_EVENTS } from '../../src/pause/index.js';
import { openStore, quarterdeckHome } from '../../src/store/index.js';
import { TIMEOUT } from './harness.js';

describe(
  'recovery when the server opens a project',
  { timeout: TIMEOUT },
  () => {
    let homeDir: string;
    let api: ApiServer | undefined;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'qd-recover-'));
    });

    afterEach(async () => {
      await api?.close();
      api = undefined;
      await rm(homeDir, { recursive: true, force: true });
    });

    const leaveBehind = async (project: string): Promise<void> => {
      const store = await openStore({
        project,
        home: quarterdeckHome(homeDir),
        databaseUrl: '',
      });
      await store.db.query(
        `insert into cards (project_id, kind, question, expires_at)
       values ($1, 'ask', 'Ship it?', now() - interval '1 minute')`,
        [store.projectId],
      );
      await store.publish({
        kind: PAUSE_EVENTS.held,
        payload: {
          operation: 'launch',
          label: 'assign: QD5i',
          scopes: ['global'],
        },
      });
      await store.close();
    };

    const kinds = async (project: string): Promise<string[]> => {
      if (!api) throw new Error('the server is not running');
      const store = await api.stores.get(project);
      const { rows } = await store.db.query<{ kind: string }>(
        `select kind from events where project_id = $1 order by id`,
        [store.projectId],
      );
      return rows.map((row) => row.kind);
    };

    it(
      'opens every project at startup and recovers each',
      { timeout: 4 * TIMEOUT },
      async () => {
        await leaveBehind('deck');
        await leaveBehind('yard');

        api = await startApiServer({
          port: 0,
          homeDir,
          databaseUrl: '',
          openProjects: true,
        });

        for (const project of ['deck', 'yard']) {
          expect(await kinds(project)).toEqual([
            PAUSE_EVENTS.held,
            'card.expired',
            PAUSE_EVENTS.dropped,
          ]);
        }
      },
    );

    it('recovers a project the first time it is opened otherwise', async () => {
      await leaveBehind('deck');
      const errors: unknown[] = [];

      api = await startApiServer({
        port: 0,
        homeDir,
        databaseUrl: '',
        onError: (err) => errors.push(err),
      });

      expect(await kinds('deck')).toEqual([
        PAUSE_EVENTS.held,
        'card.expired',
        PAUSE_EVENTS.dropped,
      ]);
      expect(await kinds('deck')).toHaveLength(3);
      expect(errors).toEqual([]);
    });
  },
);
