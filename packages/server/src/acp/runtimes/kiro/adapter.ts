import type { McpServer } from '@agentclientprotocol/sdk';
import type {
  AcpClient,
  AcpClientOptions,
  ResumeSetup,
  SessionSetup,
} from '../../client/types.js';
import { defineRuntimeAdapter, launchSite } from '../adapter.js';
import type { RuntimeAdapter, RuntimeLaunch } from '../adapter.js';
import {
  buildKiroAgentConfig,
  defaultKiroAgentsDir,
  kiroAgentName,
  removeKiroAgentConfig,
  writeKiroAgentConfig,
} from './config.js';
import { KIRO_EXTENSION_NOTIFICATIONS } from './extensions.js';

export const KIRO_COMMAND = 'kiro-cli';

export const kiroArgs = (agentName: string | undefined): string[] => [
  'acp',
  '--agent',
  kiroAgentName(agentName),
];

export interface KiroAdapterOptions {
  agentsDir?: string;
}

const withKiroExtensions = (options: AcpClientOptions): AcpClientOptions => ({
  ...options,
  extensionNotifications: [
    ...KIRO_EXTENSION_NOTIFICATIONS,
    ...(options.extensionNotifications ?? []),
  ],
});

const notConfigured =
  (configured: ReadonlySet<string>) =>
  (servers: McpServer[]): McpServer[] =>
    servers.filter((server) => !configured.has(server.name));

const wrapClient = (
  client: AcpClient,
  configured: ReadonlySet<string>,
  removed: Promise<void>,
): AcpClient => {
  const unsent = notConfigured(configured);
  return {
    ...client,
    newSession: (setup: SessionSetup) =>
      client.newSession({ ...setup, mcpServers: unsent(setup.mcpServers) }),
    resumeSession: (setup: ResumeSetup) =>
      client.resumeSession({ ...setup, mcpServers: unsent(setup.mcpServers) }),
    close: async () => {
      await client.close();
      await removed;
    },
    closed: client.closed.then(() => removed),
  };
};

export const createKiroAdapter = ({
  agentsDir = defaultKiroAgentsDir(),
}: KiroAdapterOptions = {}): RuntimeAdapter => {
  const base = defineRuntimeAdapter({
    runtime: 'kiro',
    displayName: 'Kiro',
    command: (launch: RuntimeLaunch) => ({
      command: KIRO_COMMAND,
      args: kiroArgs(launch.agentName),
      ...launchSite(launch),
    }),
  });

  const connect = async (
    launch: RuntimeLaunch,
    options: AcpClientOptions,
  ): Promise<AcpClient> => {
    const mcpServers = launch.mcpServers ?? [];
    const config = buildKiroAgentConfig(
      kiroAgentName(launch.agentName),
      mcpServers,
    );
    const path = await writeKiroAgentConfig(agentsDir, config);
    const remove = () => removeKiroAgentConfig(path);
    let client: AcpClient;
    try {
      client = await base.connect(launch, withKiroExtensions(options));
    } catch (err) {
      await remove();
      throw err;
    }
    const removed = client.closed.then(remove);
    return wrapClient(client, new Set(Object.keys(config.mcpServers)), removed);
  };

  return { ...base, connect };
};

export const KIRO_ADAPTER: RuntimeAdapter = createKiroAdapter();
