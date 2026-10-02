import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { quarterdeckHome } from '../../../store/paths.js';

export const KIRO_AGENT_PREFIX = 'quarterdeck-';

export const defaultKiroAgentsDir = (): string =>
  join(homedir(), '.kiro', 'agents');

export const defaultKiroProcessDir = (
  home: string = quarterdeckHome(),
): string => join(home, 'kiro');

export type KiroMcpServer =
  | { command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

export interface KiroAgentConfig {
  name: string;
  description: string;
  mcpServers: Record<string, KiroMcpServer>;
  tools: string[];
  allowedTools: string[];
  includeMcpJson: boolean;
}

export class KiroConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KiroConfigError';
  }
}

export const KIRO_SHADOW_CONFIG_CARD = 'kiro.shadow_config';

export class KiroShadowConfigError extends Error {
  readonly cardKind = KIRO_SHADOW_CONFIG_CARD;
  readonly agentName: string;
  readonly path: string;

  constructor(agentName: string, path: string) {
    super(
      `${path} would replace Quarterdeck's Kiro config for ${agentName}, because Kiro prefers workspace agents. Remove it before starting the agent.`,
    );
    this.name = 'KiroShadowConfigError';
    this.agentName = agentName;
    this.path = path;
  }
}

const AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

const requireName = (label: string, value: string | undefined): string => {
  if (value === undefined || !AGENT_NAME.test(value)) {
    throw new KiroConfigError(
      `Kiro needs a ${label} of letters, digits, - and _; got ${JSON.stringify(value)}`,
    );
  }
  return value;
};

export const kiroAgentName = (
  project: string | undefined,
  agentName: string | undefined,
): string =>
  `${KIRO_AGENT_PREFIX}${requireName('project', project)}-${requireName('agent name', agentName)}`;

const KIRO_AGENT_EXTENSIONS = ['.json', '.md'];

export const workspaceKiroAgentPaths = (cwd: string, name: string): string[] =>
  KIRO_AGENT_EXTENSIONS.map((extension) =>
    join(cwd, '.kiro', 'agents', `${name}${extension}`),
  );

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

export const assertNoWorkspaceShadow = async (
  cwd: string,
  name: string,
): Promise<void> => {
  const paths = workspaceKiroAgentPaths(cwd, name);
  const found = await Promise.all(paths.map(exists));
  const shadow = paths.find((_, index) => found[index]);
  if (shadow !== undefined) throw new KiroShadowConfigError(name, shadow);
};

const toRecord = (
  pairs: readonly { name: string; value: string }[],
): Record<string, string> =>
  Object.fromEntries(pairs.map(({ name, value }) => [name, value]));

const toKiroMcpServer = (server: McpServer): KiroMcpServer | undefined => {
  if (!('type' in server)) {
    return {
      command: server.command,
      args: server.args,
      env: toRecord(server.env),
    };
  }
  if (server.type === 'http') {
    return { type: 'http', url: server.url, headers: toRecord(server.headers) };
  }
  return undefined;
};

export const kiroMcpServers = (
  servers: readonly McpServer[],
): Record<string, KiroMcpServer> =>
  Object.fromEntries(
    servers.flatMap((server) => {
      const entry = toKiroMcpServer(server);
      if (!entry) return [];
      return [[server.name, entry]];
    }),
  );

export const buildKiroAgentConfig = (
  name: string,
  mcpServers: readonly McpServer[],
): KiroAgentConfig => ({
  name,
  description: 'Quarterdeck agent. Written by Quarterdeck, removed on close.',
  mcpServers: kiroMcpServers(mcpServers),
  tools: ['*'],
  allowedTools: [],
  includeMcpJson: false,
});

export const kiroAgentConfigPath = (agentsDir: string, name: string): string =>
  join(agentsDir, `${name}.json`);

export const writeKiroAgentConfig = async (
  agentsDir: string,
  config: KiroAgentConfig,
): Promise<string> => {
  await mkdir(agentsDir, { recursive: true });
  const path = kiroAgentConfigPath(agentsDir, config.name);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
};

export const removeKiroAgentConfig = (path: string): Promise<void> =>
  rm(path, { force: true });
