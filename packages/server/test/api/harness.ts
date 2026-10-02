import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer, type ApiServer } from '../../src/api/index.js';
import type { Store } from '../../src/store/index.js';

export const TIMEOUT = 30_000;

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

export interface TestApi {
  api: ApiServer;
  homeDir: string;
  send: (name: string, body: unknown, init?: RequestInit) => Promise<Reply>;
  store: (project: string) => Promise<Store>;
  close: () => Promise<void>;
}

export const startTestApi = async (
  allowedOrigins: string[] = [],
): Promise<TestApi> => {
  const homeDir = await mkdtemp(join(tmpdir(), 'qd-api-'));
  const api = await startApiServer({ port: 0, homeDir, allowedOrigins });
  const send = async (name: string, body: unknown, init: RequestInit = {}) => {
    const res = await fetch(`${api.url}/api/intents/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...init,
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      headers: res.headers,
    };
  };
  return {
    api,
    homeDir,
    send,
    store: (project) => api.stores.get(project),
    close: async () => {
      await api.close();
      await rm(homeDir, { recursive: true, force: true });
    },
  };
};

export const intentRow = async (store: Store, id: unknown) => {
  const { rows } = await store.db.query<{
    kind: string;
    status: string;
    settled: boolean;
    events: number;
  }>(
    `select i.kind, i.status, i.settled_at is not null as settled,
       (select count(*)::int from events e
        where e.payload ->> 'intentId' = i.id::text) as events
     from intents i where i.id = $1`,
    [id],
  );
  return rows[0];
};
