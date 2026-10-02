import { mkdir } from 'node:fs/promises';
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
  assertNoWorkspaceShadow,
  buildKiroAgentConfig,
  defaultKiroAgentsDir,
  defaultKiroProcessDir,
  kiroAgentName,
  removeKiroAgentConfig,
  writeKiroAgentConfig,
} from './config.js';
import { KIRO_EXTENSION_NOTIFICATIONS } from './extensions.js';

export const KIRO_COMMAND = 'kiro-cli';

export const kiroArgs = ({ project, agentName }: RuntimeLaunch): string[] => [
  'acp',
  '--agent',
  kiroAgentName(project, agentName),
];

export interface KiroAdapterOptions {
  agentsDir?: string;
  processDir?: string;
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
  processDir = defaultKiroProcessDir(),
}: KiroAdapterOptions = {}): RuntimeAdapter => {
  const inProcessDir = (launch: RuntimeLaunch): RuntimeLaunch => ({
    ...launch,
    cwd: processDir,
  });

  const base = defineRuntimeAdapter({
    runtime: 'kiro',
    displayName: 'Kiro',
    command: (launch: RuntimeLaunch) => ({
      command: KIRO_COMMAND,
      args: kiroArgs(launch),
      ...launchSite(inProcessDir(launch)),
    }),
  });

  const connect = async (
    launch: RuntimeLaunch,
    options: AcpClientOptions,
  ): Promise<AcpClient> => {
    const name = kiroAgentName(launch.project, launch.agentName);
    await assertNoWorkspaceShadow(launch.cwd, name);
    const config = buildKiroAgentConfig(name, launch.mcpServers ?? []);
    await mkdir(processDir, { recursive: true });
    const path = await writeKiroAgentConfig(agentsDir, config);
    const remove = () => removeKiroAgentConfig(path);
    let client: AcpClient;
    try {
      client = await base.connect(
        inProcessDir(launch),
        withKiroExtensions(options),
      );
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
