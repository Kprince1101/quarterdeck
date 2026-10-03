import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

export type KiroBaseSource = 'workspace' | 'machine';

export interface KiroBaseAgent {
  role: KiroBaseRole;
  name: string;
  path: string;
  source: KiroBaseSource;
  config: KiroBaseConfig;
  ignored: string[];
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

const resourceSchema = z.union([
  z.string(),
  z.looseObject({ source: z.string().optional() }),
]);

const baseFileSchema = z.looseObject({
  prompt: optional(z.string()),
  mcpServers: optional(z.record(z.string(), mcpServerSchema)),
  tools: optional(z.array(z.string())),
  allowedTools: optional(z.array(z.string())),
  toolsSettings: optional(z.record(z.string(), z.unknown())),
  resources: optional(z.array(resourceSchema)),
  model: optional(z.string()),
  includeMcpJson: optional(z.boolean()),
  hooks: z.unknown().optional(),
});

type BaseFile = z.infer<typeof baseFileSchema>;

type DroppedField =
  'hooks' | 'mcpServers' | 'allowedTools' | 'toolsSettings' | 'includeMcpJson';

const droppedFields = (
  role: KiroBaseRole,
  source: KiroBaseSource,
): ReadonlySet<DroppedField> => {
  const fields: DroppedField[] = ['hooks'];
  if (source === 'workspace') {
    fields.push('mcpServers', 'allowedTools', 'toolsSettings');
  }
  if (role === 'builder') fields.push('includeMcpJson');
  return new Set(fields);
};

const takesEffect = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value !== 'object') return true;
  return Object.keys(value).length > 0;
};

interface BaseScope {
  path: string;
  home: string;
  repoDir?: string;
}

const FILE_SCHEME = 'file://';
const URI_SCHEMES = [FILE_SCHEME, 'skill://'];
const HOME_PATH = /^~(?=$|[\\/])/;

const uriScheme = (uri: string): string | undefined =>
  URI_SCHEMES.find((prefix) => uri.startsWith(prefix));

const resolveUri = (uri: string, dir: string): string => {
  const scheme = uriScheme(uri);
  if (scheme === undefined) return uri;
  const path = uri.slice(scheme.length);
  if (isAbsolute(path) || path.startsWith('~')) return uri;
  return `${scheme}${resolve(dir, path)}`;
};

const uriTarget = (uri: string, scheme: string, scope: BaseScope): string =>
  resolve(
    dirname(scope.path),
    uri.slice(scheme.length).replace(HOME_PATH, scope.home),
  );

const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
};

const assertInRepo = (scope: BaseScope, target: string, what: string): void => {
  if (scope.repoDir === undefined || isInside(scope.repoDir, target)) return;
  throw new KiroConfigError(
    `${scope.path} names ${what} ${target}, outside ${scope.repoDir}. A base agent in the repo may only point inside the repo.`,
  );
};

const resolveUriIn = (uri: string, scope: BaseScope): string => {
  const scheme = uriScheme(uri);
  if (scheme !== undefined) {
    assertInRepo(scope, uriTarget(uri, scheme, scope), 'resource');
  }
  return resolveUri(uri, dirname(scope.path));
};

const resolveResource = (
  resource: KiroResource,
  scope: BaseScope,
): KiroResource => {
  if (typeof resource === 'string') return resolveUriIn(resource, scope);
  const { source } = resource;
  if (typeof source !== 'string') return resource;
  return { ...resource, source: resolveUriIn(source, scope) };
};

const unreadablePrompt = (
  scope: BaseScope,
  file: string,
  err: unknown,
): KiroConfigError =>
  new KiroConfigError(
    `${scope.path} names prompt ${file}, which Quarterdeck cannot read: ${getErrorMessage(err)}`,
  );

const assertPromptInRepo = async (
  scope: BaseScope,
  file: string,
): Promise<void> => {
  if (scope.repoDir === undefined) return;
  assertInRepo(scope, file, 'prompt');
  let real: string;
  try {
    real = await realpath(file);
  } catch (err) {
    throw unreadablePrompt(scope, file, err);
  }
  const repo = await realpath(scope.repoDir);
  assertInRepo({ ...scope, repoDir: repo }, real, 'prompt');
};

const readPrompt = async (
  prompt: string | null | undefined,
  scope: BaseScope,
): Promise<string | undefined> => {
  if (!prompt) return undefined;
  if (!prompt.startsWith(FILE_SCHEME)) return prompt;
  const file = uriTarget(prompt, FILE_SCHEME, scope);
  await assertPromptInRepo(scope, file);
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    throw unreadablePrompt(scope, file, err);
  }
};

const unlessDropped = <K extends DroppedField>(
  dropped: ReadonlySet<DroppedField>,
  field: K,
  value: BaseFile[K],
): NonNullable<BaseFile[K]> | undefined => {
  if (dropped.has(field)) return undefined;
  return value ?? undefined;
};

const toBaseConfig = async (
  file: BaseFile,
  scope: BaseScope,
  dropped: ReadonlySet<DroppedField>,
): Promise<KiroBaseConfig> =>
  withoutUndefined<KiroBaseConfig>({
    prompt: await readPrompt(file.prompt, scope),
    mcpServers: unlessDropped(dropped, 'mcpServers', file.mcpServers),
    tools: file.tools ?? undefined,
    allowedTools: unlessDropped(dropped, 'allowedTools', file.allowedTools),
    toolsSettings: unlessDropped(dropped, 'toolsSettings', file.toolsSettings),
    resources: file.resources?.map((resource) =>
      resolveResource(resource, scope),
    ),
    model: file.model ?? undefined,
    includeMcpJson: unlessDropped(
      dropped,
      'includeMcpJson',
      file.includeMcpJson,
    ),
  });

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

const workspaceBasePath = (repoDir: string, name: string): string =>
  join(resolve(repoDir), '.kiro', 'agents', `${name}.json`);

export const kiroBaseAgentPaths = (
  role: KiroBaseRole,
  name: string,
  { agentsDir, rules }: KiroBaseOptions,
): string[] => {
  const global = join(agentsDir, `${name}.json`);
  if (role !== 'builder' || rules.repoDir === undefined) return [global];
  return [workspaceBasePath(rules.repoDir, name), global];
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

const baseScope = (
  role: KiroBaseRole,
  name: string,
  path: string,
  rules: LoadRulesOptions,
): BaseScope => {
  const home = rules.homeDir ?? homedir();
  const { repoDir } = rules;
  if (role !== 'builder' || repoDir === undefined) return { path, home };
  if (path !== workspaceBasePath(repoDir, name)) return { path, home };
  return { path, home, repoDir: resolve(repoDir) };
};

const scopeSource = (scope: BaseScope): KiroBaseSource => {
  if (scope.repoDir === undefined) return 'machine';
  return 'workspace';
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
  const scope = baseScope(role, name, path, options.rules);
  const source = scopeSource(scope);
  const dropped = droppedFields(role, source);
  return {
    role,
    name,
    path,
    source,
    config: await toBaseConfig(file, scope, dropped),
    ignored: [...dropped].filter((field) => takesEffect(file[field])),
  };
};

export const isKiroBaseRole = (role: unknown): role is KiroBaseRole =>
  kiroBaseRoleSchema.safeParse(role).success;

export const KIRO_BASE_ROLES: readonly KiroBaseRole[] =
  kiroBaseRoleSchema.options;
