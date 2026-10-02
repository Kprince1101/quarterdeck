import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  createBusServer,
  loadBusTools,
  type BusTool,
} from '../../src/bus/index.js';

export const TIMEOUT = 30_000;

export interface ToolReply {
  text: string;
  isError: boolean;
}

export const openTestStore = (project: string): Promise<Store> =>
  openStore({ project, dataDir: IN_MEMORY });

export const insertAgent = async (
  store: Pick<Store, 'db'>,
  projectId: string,
  name: string,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into agents (project_id, name, role) values ($1, $2, 'builder')
     returning id`,
    [projectId, name],
  );
  const [row] = rows;
  if (!row) throw new Error(`could not insert agent ${name}`);
  return row.id;
};

export const insertProject = async (
  store: Pick<Store, 'db'>,
  slug: string,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    'insert into projects (slug, name) values ($1, $1) returning id',
    [slug],
  );
  const [row] = rows;
  if (!row) throw new Error(`could not insert project ${slug}`);
  return row.id;
};

export const connectClient = async (
  store: Store,
  agentId: string,
  tools?: readonly BusTool[],
): Promise<Client> => {
  const server = createBusServer(
    { store, agentId },
    tools ?? (await loadBusTools()),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'bus-test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
};

export const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolReply> => {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return {
    text: content.map((part) => part.text ?? '').join(''),
    isError: result.isError === true,
  };
};

export const readRows = async (
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>[]> => {
  const reply = await callTool(client, 'read', args);
  if (reply.isError) throw new Error(reply.text);
  return JSON.parse(reply.text) as Record<string, unknown>[];
};
