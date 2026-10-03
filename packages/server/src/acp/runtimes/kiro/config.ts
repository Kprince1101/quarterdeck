import { access, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { writePrivateFile } from '../../../lib/private-fs.js';
import { quarterdeckHome } from '../../../store/paths.js';
import type { KiroBaseAgent, KiroResource } from './base-agent.js';

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
  prompt?: string;
  mcpServers: Record<string, KiroMcpServer | Record<string, unknown>>;
  tools: string[];
  allowedTools: string[];
  toolsSettings?: Record<string, unknown>;
  resources?: KiroResource[];
  model?: string;
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

export interface KiroConfigInputs {
  base?: KiroBaseAgent | undefined;
  prompt?: string | undefined;
}

const DESCRIPTION =
  'Quarterdeck agent. Written by Quarterdeck, removed on close.';

const assertNoNameClash = (
  base: KiroBaseAgent,
  ours: Record<string, KiroMcpServer>,
): void => {
  const clash = Object.keys(base.config.mcpServers ?? {}).find((server) =>
    Object.hasOwn(ours, server),
  );
  if (clash === undefined) return;
  throw new KiroConfigError(
    `${base.path} has an MCP server named ${clash}, which is Quarterdeck's own. Rename it in the base agent.`,
  );
};

const withOurServers = (
  tools: string[],
  ours: Record<string, KiroMcpServer>,
): string[] => {
  if (tools.includes('*')) return tools;
  const missing = Object.keys(ours)
    .map((server) => `@${server}`)
    .filter((tool) => !tools.includes(tool));
  return [...tools, ...missing];
};

const joinPrompts = (
  ...prompts: (string | undefined)[]
): string | undefined => {
  const present = prompts.filter((prompt) => prompt !== undefined);
  if (present.length === 0) return undefined;
  return present.join('\n\n');
};

export const withoutUndefined = <T extends object>(value: {
  [K in keyof T]: T[K] | undefined;
}): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

export const buildKiroAgentConfig = (
  name: string,
  mcpServers: readonly McpServer[],
  { base, prompt }: KiroConfigInputs = {},
): KiroAgentConfig => {
  const ours = kiroMcpServers(mcpServers);
  if (!base) {
    return withoutUndefined<KiroAgentConfig>({
      name,
      description: DESCRIPTION,
      prompt,
      mcpServers: ours,
      tools: ['*'],
      allowedTools: [],
      includeMcpJson: false,
    });
  }
  assertNoNameClash(base, ours);
  const { config } = base;
  return withoutUndefined<KiroAgentConfig>({
    name,
    description: DESCRIPTION,
    prompt: joinPrompts(config.prompt, prompt),
    mcpServers: { ...config.mcpServers, ...ours },
    tools: withOurServers(config.tools ?? ['*'], ours),
    allowedTools: config.allowedTools ?? [],
    toolsSettings: config.toolsSettings,
    resources: config.resources,
    model: config.model,
    includeMcpJson: config.includeMcpJson ?? false,
  });
};

export const kiroAgentConfigPath = (agentsDir: string, name: string): string =>
  join(agentsDir, `${name}.json`);

export const writeKiroAgentConfig = async (
  agentsDir: string,
  config: KiroAgentConfig,
): Promise<string> => {
  await mkdir(agentsDir, { recursive: true });
  const path = kiroAgentConfigPath(agentsDir, config.name);
  await writePrivateFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
};

export const removeKiroAgentConfig = (path: string): Promise<void> =>
  rm(path, { force: true });
