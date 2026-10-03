import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
  role = 'builder',
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into agents (project_id, name, role) values ($1, $2, $3)
     returning id`,
    [projectId, name, role],
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

export interface TicketRow {
  status: string;
  assignee_id: string | null;
  pr_url: string | null;
  head_sha: string | null;
}

export const insertTicket = async (
  store: Pick<Store, 'db'>,
  projectId: string,
  extra: { status?: string; assignee?: string } = {},
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into tickets (project_id, title, status, assignee_id)
     values ($1, 'QD4c report + verdict', $2, $3) returning id`,
    [projectId, extra.status ?? 'open', extra.assignee ?? null],
  );
  const [row] = rows;
  if (!row) throw new Error('could not insert ticket');
  return row.id;
};

export const ticketRow = async (
  store: Pick<Store, 'db'>,
  ticketId: string,
): Promise<TicketRow | undefined> => {
  const { rows } = await store.db.query<TicketRow>(
    'select status, assignee_id, pr_url, head_sha from tickets where id = $1',
    [ticketId],
  );
  return rows[0];
};

export interface TicketEvent {
  agent_id: string | null;
  ticket_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export const ticketEvents = async (
  store: Pick<Store, 'db'>,
): Promise<TicketEvent[]> => {
  const { rows } = await store.db.query<TicketEvent>(
    `select agent_id, ticket_id, kind, payload from events
     where kind like 'ticket.%' order by id`,
  );
  return rows;
};

export const connectClient = async (
  store: Store,
  agentId: string,
  tools?: readonly BusTool[],
  askExpiryMs?: number,
  openStores?: () => readonly Store[],
): Promise<Client> => {
  const server = createBusServer(
    { store, agentId, askExpiryMs, openStores },
    tools ?? (await loadBusTools()),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'bus-test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
};

export const envOf = (launch: McpServerStdio): Record<string, string> =>
  Object.fromEntries(launch.env.map(({ name, value }) => [name, value]));

export const connectStdio = async (launch: McpServerStdio): Promise<Client> => {
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: envOf(launch),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bus-host-test', version: '0.0.0' });
  await client.connect(transport);
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
