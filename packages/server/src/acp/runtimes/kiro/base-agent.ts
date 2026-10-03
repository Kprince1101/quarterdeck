import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  kiroBaseRoleSchema,
  loadRule,
  type KiroBaseRole,
  type LoadRulesOptions,
} from '@quarterdeck/rules';
import { z } from 'zod';
import { getErrorMessage } from '../../../lib/errors.js';
import {
  KIRO_AGENT_PREFIX,
  KiroConfigError,
  withoutUndefined,
} from './config.js';

export type KiroResource = string | Record<string, unknown>;

export interface KiroBaseConfig {
  prompt?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
  tools?: string[];
  allowedTools?: string[];
  toolsSettings?: Record<string, unknown>;
  resources?: KiroResource[];
  model?: string;
  includeMcpJson?: boolean;
}

export interface KiroBaseAgent {
  role: KiroBaseRole;
  name: string;
  path: string;
  config: KiroBaseConfig;
  ignoredHooks: boolean;
}

export interface KiroBaseOptions {
  agentsDir: string;
  rules: LoadRulesOptions;
}

const optional = <T extends z.ZodType>(schema: T) => schema.nullish();

const stringMap = z.record(z.string(), z.string());

const mcpServerSchema = z
  .looseObject({
    type: z.string().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: stringMap.optional(),
    url: z.string().min(1).optional(),
    headers: stringMap.optional(),
    timeout: z.number().optional(),
    disabled: z.boolean().optional(),
  })
  .refine(
    (server) => server.command !== undefined || server.url !== undefined,
    'an MCP server needs a command or a url',
  );

const baseFileSchema = z.looseObject({
  prompt: optional(z.string()),
  mcpServers: optional(z.record(z.string(), mcpServerSchema)),
  tools: optional(z.array(z.string())),
  allowedTools: optional(z.array(z.string())),
  toolsSettings: optional(z.record(z.string(), z.unknown())),
  resources: optional(z.array(z.union([z.string(), z.looseObject({})]))),
  model: optional(z.string()),
  includeMcpJson: optional(z.boolean()),
  hooks: z.unknown().optional(),
});

type BaseFile = z.infer<typeof baseFileSchema>;

const URI_SCHEMES = ['file://', 'skill://'];

const resolveUri = (uri: string, dir: string): string => {
  const scheme = URI_SCHEMES.find((prefix) => uri.startsWith(prefix));
  if (scheme === undefined) return uri;
  const path = uri.slice(scheme.length);
  if (isAbsolute(path) || path.startsWith('~')) return uri;
  return `${scheme}${resolve(dir, path)}`;
};

const resolveResource = (resource: KiroResource, dir: string): KiroResource => {
  if (typeof resource === 'string') return resolveUri(resource, dir);
  const { source } = resource;
  if (typeof source !== 'string') return resource;
  return { ...resource, source: resolveUri(source, dir) };
};

const FILE_SCHEME = 'file://';

const HOME_PATH = /^~(?=$|[\\/])/;

const promptFile = (prompt: string, path: string, home: string): string => {
  const file = resolveUri(prompt, dirname(path)).slice(FILE_SCHEME.length);
  return file.replace(HOME_PATH, home);
};

const readPrompt = async (
  prompt: string | null | undefined,
  path: string,
  home: string,
): Promise<string | undefined> => {
  if (!prompt) return undefined;
  if (!prompt.startsWith(FILE_SCHEME)) return prompt;
  const file = promptFile(prompt, path, home);
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    throw new KiroConfigError(
      `${path} names prompt ${file}, which Quarterdeck cannot read: ${getErrorMessage(err)}`,
    );
  }
};

const hasHooks = (hooks: unknown): boolean => {
  if (hooks === undefined || hooks === null) return false;
  if (typeof hooks !== 'object') return true;
  return Object.keys(hooks).length > 0;
};

const toBaseConfig = async (
  file: BaseFile,
  path: string,
  home: string,
): Promise<KiroBaseConfig> => {
  const dir = dirname(path);
  return withoutUndefined<KiroBaseConfig>({
    prompt: await readPrompt(file.prompt, path, home),
    mcpServers: file.mcpServers ?? undefined,
    tools: file.tools ?? undefined,
    allowedTools: file.allowedTools ?? undefined,
    toolsSettings: file.toolsSettings ?? undefined,
    resources: file.resources?.map((resource) =>
      resolveResource(resource, dir),
    ),
    model: file.model ?? undefined,
    includeMcpJson: file.includeMcpJson ?? undefined,
  });
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const parseBaseFile = (path: string, text: string): BaseFile => {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (err) {
    throw new KiroConfigError(
      `${path} is not a valid Kiro agent: ${getErrorMessage(err)}`,
    );
  }
  const result = baseFileSchema.safeParse(value);
  if (!result.success) {
    throw new KiroConfigError(
      `${path} is not a valid Kiro agent\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
};

const readBaseFile = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new KiroConfigError(
      `${path} could not be read: ${getErrorMessage(err)}`,
    );
  }
};

export const kiroBaseAgentPaths = (
  role: KiroBaseRole,
  name: string,
  { agentsDir, rules }: KiroBaseOptions,
): string[] => {
  const global = join(agentsDir, `${name}.json`);
  if (role !== 'builder' || rules.repoDir === undefined) return [global];
  return [join(rules.repoDir, '.kiro', 'agents', `${name}.json`), global];
};

const ruleOptions = (
  role: KiroBaseRole,
  rules: LoadRulesOptions,
): LoadRulesOptions => {
  if (role === 'builder') return rules;
  const { repoDir: _repoDir, ...machine } = rules;
  return machine;
};

export const kiroBaseAgentName = async (
  role: KiroBaseRole,
  rules: LoadRulesOptions,
): Promise<string | null> => {
  const kiro = await loadRule('kiro', ruleOptions(role, rules));
  return kiro.baseAgents[role];
};

const findBaseFile = async (
  role: KiroBaseRole,
  paths: string[],
): Promise<string> => {
  for (const path of paths) {
    if (await exists(path)) return path;
  }
  throw new KiroConfigError(
    `The ${role}'s Kiro base agent is missing: no ${paths.join(' or ')}`,
  );
};

export const loadKiroBaseAgent = async (
  role: KiroBaseRole,
  options: KiroBaseOptions,
): Promise<KiroBaseAgent | undefined> => {
  const name = await kiroBaseAgentName(role, options.rules);
  if (name === null) return undefined;
  const paths = kiroBaseAgentPaths(role, name, options);
  if (name.toLowerCase().startsWith(KIRO_AGENT_PREFIX)) {
    throw new KiroConfigError(
      `The ${role}'s Kiro base agent ${paths.join(' or ')} starts with ${KIRO_AGENT_PREFIX}, which is kept for the agents Quarterdeck writes. Rename it.`,
    );
  }
  const path = await findBaseFile(role, paths);
  const file = parseBaseFile(path, await readBaseFile(path));
  const home = options.rules.homeDir ?? homedir();
  return {
    role,
    name,
    path,
    config: await toBaseConfig(file, path, home),
    ignoredHooks: hasHooks(file.hooks),
  };
};

export const isKiroBaseRole = (role: unknown): role is KiroBaseRole =>
  kiroBaseRoleSchema.safeParse(role).success;

export const KIRO_BASE_ROLES: readonly KiroBaseRole[] =
  kiroBaseRoleSchema.options;
