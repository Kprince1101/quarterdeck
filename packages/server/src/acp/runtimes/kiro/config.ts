import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';

export const KIRO_AGENT_PREFIX = 'quarterdeck-';

export const defaultKiroAgentsDir = (): string =>
  join(homedir(), '.kiro', 'agents');

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

const AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

export const kiroAgentName = (agentName: string | undefined): string => {
  if (agentName === undefined || !AGENT_NAME.test(agentName)) {
    throw new KiroConfigError(
      `Kiro needs an agent name of letters, digits, - and _; got ${JSON.stringify(agentName)}`,
    );
  }
  return `${KIRO_AGENT_PREFIX}${agentName}`;
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
