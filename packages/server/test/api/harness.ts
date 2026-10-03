import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startApiServer,
  type ApiServer,
  type ApiServerOptions,
} from '../../src/api/index.js';
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

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

const parseBody = (text: string): Record<string, unknown> => {
  if (text === '') return {};
  return JSON.parse(text) as Record<string, unknown>;
};

export const readReply = async (res: Response): Promise<Reply> => ({
  status: res.status,
  body: parseBody(await res.text()),
  headers: res.headers,
});

export const startTestApi = async (
  allowedOrigins: string[] = [],
  databaseUrl?: string,
  options: ApiServerOptions = {},
): Promise<TestApi> => {
  const homeDir = await mkdtemp(join(tmpdir(), 'qd-api-'));
  const api = await startApiServer({
    ...options,
    port: 0,
    homeDir,
    allowedOrigins,
    databaseUrl,
  });
  const send = async (
    name: string,
    body: unknown,
    { headers, ...init }: RequestInit = {},
  ) =>
    readReply(
      await fetch(`${api.url}/api/intents/${name}`, {
        method: 'POST',
        body: JSON.stringify(body),
        ...init,
        headers: {
          'content-type': 'application/json',
          ...bearer(api.token),
          ...(headers as Record<string, string> | undefined),
        },
      }),
    );
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
