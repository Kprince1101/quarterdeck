import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { getErrorMessage, hasErrorCode } from '../../../lib/errors.js';
import { redactShapes } from '../../../lib/redact.js';
import { quarterdeckHome } from '../../../store/paths.js';
import { sourceEnv, type ChildEnvSpec } from '../../env.js';
import { runCommand } from '../../launch/run.js';
import {
  CLAUDE_AUTH_MODES,
  claudeAuthModeSchema,
  type ClaudeAuthMode,
  type ClaudeAuthSource,
  type ClaudeAuthStatus,
  type ClaudeKeySource,
} from './auth-mode.js';

export const DEFAULT_CLAUDE_AUTH_MODE: ClaudeAuthMode = 'subscription';
export const CLAUDE_AUTH_ENV = 'QUARTERDECK_CLAUDE_AUTH';
export const CLAUDE_AUTH_FILE = 'claude.json';
export const CLAUDE_AUTH_ERROR = 'claude_auth';
export const CLAUDE_KEYCHAIN_SERVICE = 'quarterdeck-anthropic-api-key';
export const CLAUDE_KEYCHAIN_TIMEOUT_MS = 10_000;
export const CLAUDE_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const CLAUDE_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';
export const CLAUDE_VERTEX_FLAG_ENV = 'CLAUDE_CODE_USE_VERTEX';
export const CLAUDE_VERTEX_REQUIRED_ENV: readonly string[] = [
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
];
export const CLAUDE_VERTEX_PASS_ENV: readonly string[] = [
  ...CLAUDE_VERTEX_REQUIRED_ENV,
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_CONFIG',
  'ANTHROPIC_VERTEX_BASE_URL',
];

export const claudeAuthFileSchema = z.strictObject({
  auth: claudeAuthModeSchema,
});

export const claudeAuthPath = (home: string = quarterdeckHome()): string =>
  join(home, CLAUDE_AUTH_FILE);

export class ClaudeAuthError extends Error {
  readonly code = CLAUDE_AUTH_ERROR;
  readonly mode: ClaudeAuthMode | null;
  readonly missing: readonly string[];

  constructor(
    message: string,
    mode: ClaudeAuthMode | null = null,
    missing: readonly string[] = [],
  ) {
    super(redactShapes(message));
    this.name = 'ClaudeAuthError';
    this.mode = mode;
    this.missing = missing;
  }
}

export interface ClaudeAuthSetting {
  mode: ClaudeAuthMode;
  source: ClaudeAuthSource;
}

export type KeychainRead = (service: string) => Promise<string | undefined>;

export interface ClaudeAuthOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  readKeychain?: KeychainRead;
}

export interface ClaudeAuth {
  status: ClaudeAuthStatus;
  env: ChildEnvSpec;
}

const MODE_LIST = CLAUDE_AUTH_MODES.join(', ');

const nonEmpty = (value: string | undefined): string | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  return value;
};

const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return undefined;
    throw new ClaudeAuthError(`${path}: ${getErrorMessage(err)}`);
  }
};

const parseEnvMode = (value: string): ClaudeAuthMode => {
  const parsed = claudeAuthModeSchema.safeParse(value.trim());
  if (parsed.success) return parsed.data;
  throw new ClaudeAuthError(
    `${CLAUDE_AUTH_ENV} is ${JSON.stringify(value)}; set it to one of ${MODE_LIST}`,
  );
};

const parseJson = (path: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ClaudeAuthError(`${path}: ${getErrorMessage(err)}`);
  }
};

const parseFileMode = (path: string, text: string): ClaudeAuthMode => {
  const parsed = claudeAuthFileSchema.safeParse(parseJson(path, text));
  if (parsed.success) return parsed.data.auth;
  throw new ClaudeAuthError(
    `${path}: expected {"auth": "<mode>"} with a mode of ${MODE_LIST}`,
  );
};

export const readClaudeAuthSetting = async ({
  env = sourceEnv(),
  homeDir = homedir(),
}: ClaudeAuthOptions = {}): Promise<ClaudeAuthSetting> => {
  const fromEnv = nonEmpty(env[CLAUDE_AUTH_ENV]);
  if (fromEnv !== undefined) {
    return { mode: parseEnvMode(fromEnv), source: 'env' };
  }
  const path = claudeAuthPath(quarterdeckHome(homeDir));
  const text = await readOptional(path);
  if (text === undefined) {
    return { mode: DEFAULT_CLAUDE_AUTH_MODE, source: 'default' };
  }
  return { mode: parseFileMode(path, text), source: 'file' };
};

export const readMacKeychain: KeychainRead = async (service) => {
  const result = await runCommand(
    {
      command: 'security',
      args: ['find-generic-password', '-s', service, '-w'],
    },
    { timeoutMs: CLAUDE_KEYCHAIN_TIMEOUT_MS },
  );
  if (result.status !== 'exited' || result.code !== 0) return undefined;
  return nonEmpty(result.stdout.trim());
};

const NO_KEYCHAIN: KeychainRead = async () => undefined;

export const keychainFor = (platform: NodeJS.Platform): KeychainRead => {
  if (platform === 'darwin') return readMacKeychain;
  return NO_KEYCHAIN;
};

interface ModeEnv {
  missing: string[];
  keySource: ClaudeKeySource | null;
  env: ChildEnvSpec;
}

type ModeResolver = (
  env: NodeJS.ProcessEnv,
  readKeychain: KeychainRead,
) => Promise<ModeEnv>;

const withKey = (key: string, keySource: ClaudeKeySource): ModeEnv => ({
  missing: [],
  keySource,
  env: { set: { [CLAUDE_API_KEY_ENV]: key } },
});

const MODE_RESOLVERS: Record<ClaudeAuthMode, ModeResolver> = {
  subscription: async () => ({ missing: [], keySource: null, env: {} }),
  api_key: async (env, readKeychain) => {
    const fromEnv = nonEmpty(env[CLAUDE_API_KEY_ENV]);
    if (fromEnv !== undefined) return withKey(fromEnv, 'env');
    const fromKeychain = nonEmpty(await readKeychain(CLAUDE_KEYCHAIN_SERVICE));
    if (fromKeychain !== undefined) return withKey(fromKeychain, 'keychain');
    return { missing: [CLAUDE_API_KEY_ENV], keySource: null, env: {} };
  },
  vertex: async (env) => ({
    missing: CLAUDE_VERTEX_REQUIRED_ENV.filter(
      (name) => nonEmpty(env[name]) === undefined,
    ),
    keySource: null,
    env: {
      pass: CLAUDE_VERTEX_PASS_ENV,
      set: { [CLAUDE_VERTEX_FLAG_ENV]: '1' },
    },
  }),
};

export const resolveClaudeAuth = async (
  options: ClaudeAuthOptions = {},
): Promise<ClaudeAuth> => {
  const env = options.env ?? sourceEnv();
  const setting = await readClaudeAuthSetting(options);
  const readKeychain =
    options.readKeychain ?? keychainFor(options.platform ?? process.platform);
  const resolved = await MODE_RESOLVERS[setting.mode](env, readKeychain);
  return {
    status: {
      ...setting,
      missing: resolved.missing,
      keySource: resolved.keySource,
      gateway: nonEmpty(env[CLAUDE_BASE_URL_ENV]) !== undefined,
    },
    env: resolved.env,
  };
};

export const claudeAuthStatus = async (
  options: ClaudeAuthOptions = {},
): Promise<ClaudeAuthStatus> => (await resolveClaudeAuth(options)).status;

const MISSING_HELP: Record<ClaudeAuthMode, string> = {
  subscription: '',
  api_key: `Export ${CLAUDE_API_KEY_ENV} before starting Quarterdeck, or on macOS store it in the Keychain: security add-generic-password -a "$USER" -s ${CLAUDE_KEYCHAIN_SERVICE} -w`,
  vertex: `Export ${CLAUDE_VERTEX_REQUIRED_ENV.join(' and ')} before starting Quarterdeck, and sign in with gcloud auth application-default login`,
};

export const claudeAuthMissingHelp = (mode: ClaudeAuthMode): string =>
  MISSING_HELP[mode];

export const claudeAuthEnv = async (
  options: ClaudeAuthOptions = {},
): Promise<ChildEnvSpec> => {
  const { status, env } = await resolveClaudeAuth(options);
  if (status.missing.length === 0) return env;
  const missing = status.missing.join(' and ');
  throw new ClaudeAuthError(
    `Claude auth mode ${status.mode} needs ${missing}, which is not set. ${claudeAuthMissingHelp(status.mode)}.`,
    status.mode,
    status.missing,
  );
};
