import type { McpServer } from '@agentclientprotocol/sdk';
import { ensurePrivateDir } from '../../../lib/private-fs.js';
import type {
  AcpClient,
  AgentCommand,
  ResumeSetup,
  SessionSetup,
} from '../../client/types.js';
import { launchAcpClient } from '../../launch/launch.js';
import type { AgentLaunch, LaunchOptions } from '../../launch/launch.js';
import { launchSite } from '../adapter.js';
import type {
  RuntimeAdapter,
  RuntimeAdapterSpec,
  RuntimeLaunch,
} from '../adapter.js';
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

export const KIRO_PASS_ENV: readonly string[] = [];

export const kiroArgs = ({ project, agentName }: RuntimeLaunch): string[] => [
  'acp',
  '--agent',
  kiroAgentName(project, agentName),
];

export interface KiroAdapterOptions {
  agentsDir?: string;
  processDir?: string;
}

const withKiroExtensions = (options: LaunchOptions): LaunchOptions => ({
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

  const spec: RuntimeAdapterSpec = {
    runtime: 'kiro',
    displayName: 'Kiro',
    passEnv: KIRO_PASS_ENV,
    command: (launch: RuntimeLaunch) => ({
      command: KIRO_COMMAND,
      args: kiroArgs(launch),
      ...launchSite(inProcessDir(launch)),
    }),
  };

  const kiroCommand = (launch: RuntimeLaunch): AgentCommand => {
    if (!launch.command) return spec.command(launch);
    return {
      ...launchSite(inProcessDir(launch)),
      ...launch.command,
      cwd: processDir,
    };
  };

  const agentLaunch = (launch: RuntimeLaunch): AgentLaunch => {
    const command = kiroCommand(launch);
    return { command, version: { ...command, args: ['--version'] } };
  };

  const connect = async (
    launch: RuntimeLaunch,
    options: LaunchOptions,
  ): Promise<AcpClient> => {
    const name = kiroAgentName(launch.project, launch.agentName);
    await assertNoWorkspaceShadow(launch.cwd, name);
    const config = buildKiroAgentConfig(name, launch.mcpServers ?? []);
    await ensurePrivateDir(processDir);
    const path = await writeKiroAgentConfig(agentsDir, config);
    const remove = () => removeKiroAgentConfig(path);
    let client: AcpClient;
    try {
      client = await launchAcpClient(
        agentLaunch(launch),
        withKiroExtensions(options),
      );
    } catch (err) {
      await remove();
      throw err;
    }
    const removed = client.closed.then(remove);
    return wrapClient(client, new Set(Object.keys(config.mcpServers)), removed);
  };

  return { ...spec, passEnv: KIRO_PASS_ENV, connect };
};

export const KIRO_ADAPTER: RuntimeAdapter = createKiroAdapter();
