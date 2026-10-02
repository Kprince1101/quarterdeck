import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  serveStream,
  startApiServer,
  type ApiServer,
  type ServedStream,
  type Store,
} from '@quarterdeck/server';
import { createIntentClient, type IntentClient } from '../../src/api/index.js';
import type { StreamConnection, StreamState } from '../../src/api/index.js';

export const TIMEOUT = 30_000;

export interface Deck {
  api: ApiServer;
  client: IntentClient;
  project: string;
  store: Store;
  serve: (port?: number) => Promise<ServedStream>;
  close: () => Promise<void>;
}

export const startDeck = async (project: string): Promise<Deck> => {
  const homeDir = await mkdtemp(join(tmpdir(), 'qd-dashboard-'));
  const api = await startApiServer({ port: 0, homeDir });
  const client = createIntentClient({ baseUrl: api.url });
  await client.project.create({ project });
  const store = await api.stores.get(project);
  const served: ServedStream[] = [];
  return {
    api,
    client,
    project,
    store,
    serve: async (port = 0) => {
      const stream = await serveStream({ store, port });
      served.push(stream);
      return stream;
    },
    close: async () => {
      await Promise.all(served.map((stream) => stream.close()));
      await api.close();
      await rm(homeDir, { recursive: true, force: true });
    },
  };
};

export const waitFor = (
  connection: StreamConnection,
  ready: (state: StreamState) => boolean,
): Promise<StreamState> =>
  new Promise((resolve) => {
    if (ready(connection.state)) {
      resolve(connection.state);
      return;
    }
    const unsubscribe = connection.subscribe((state) => {
      if (!ready(state)) return;
      unsubscribe();
      resolve(state);
    });
  });
