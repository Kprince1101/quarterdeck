import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLAUDE_API_KEY_ENV,
  CLAUDE_AUTH_ENV,
  CLAUDE_AUTH_MODES,
  CLAUDE_BASE_URL_ENV,
  CLAUDE_KEYCHAIN_SERVICE,
  ClaudeAuthError,
  claudeAuthPath,
  quarterdeckHome,
  resolveClaudeAuth,
  type ClaudeAuthMode,
  type ClaudeAuthOptions,
  type ClaudeAuthSource,
  type ClaudeAuthStatus,
  type KeychainRead,
} from '@quarterdeck/server';
import type { DoctorCheck } from './doctor.js';
import type { CliIo } from './io.js';

export const CLAUDE_AUTH_CHECK = 'claude auth';

export const CLAUDE_AUTH_FIXES = {
  apiKeyEnv: `export ${CLAUDE_API_KEY_ENV}=<your key>, then start Quarterdeck from that shell`,
  apiKeyKeychain: `security add-generic-password -a "$USER" -s ${CLAUDE_KEYCHAIN_SERVICE} -w`,
  adc: 'gcloud auth application-default login',
  mode: `set ${CLAUDE_AUTH_ENV} or ~/.quarterdeck/claude.json {"auth": ...} to one of ${CLAUDE_AUTH_MODES.join(', ')}`,
} as const;

const ADC_FILE = 'application_default_credentials.json';

export interface ClaudeAuthCheckOptions {
  platform?: NodeJS.Platform;
  readKeychain?: KeychainRead;
}

type Fixes = DoctorCheck['fixes'];

const authOptions = (
  io: CliIo,
  { platform = process.platform, readKeychain }: ClaudeAuthCheckOptions,
): ClaudeAuthOptions => ({
  env: io.env,
  homeDir: io.homeDir,
  platform,
  ...(readKeychain !== undefined && { readKeychain }),
});

const sourceText = (io: CliIo, source: ClaudeAuthSource): string => {
  const sources: Record<ClaudeAuthSource, string> = {
    env: `from ${CLAUDE_AUTH_ENV}`,
    file: `from ${claudeAuthPath(quarterdeckHome(io.homeDir))}`,
    default: 'the default',
  };
  return sources[source];
};

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

const adcPath = (io: CliIo, platform: NodeJS.Platform): string => {
  const explicit = io.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (explicit) return explicit;
  const config = io.env['CLOUDSDK_CONFIG'];
  if (config) return join(config, ADC_FILE);
  const appData = io.env['APPDATA'];
  if (platform === 'win32' && appData) return join(appData, 'gcloud', ADC_FILE);
  return join(io.homeDir, '.config', 'gcloud', ADC_FILE);
};

interface Finding {
  detail: string;
  fixes: Fixes;
}

const missingFixes = (
  status: ClaudeAuthStatus,
  platform: NodeJS.Platform,
): Fixes => {
  if (status.mode !== 'api_key') {
    return status.missing.map((name) => ({
      label: 'Set',
      command: `export ${name}=<value>, then start Quarterdeck from that shell`,
    }));
  }
  const env: Fixes = [{ label: 'Set', command: CLAUDE_AUTH_FIXES.apiKeyEnv }];
  if (platform !== 'darwin') return env;
  return [...env, { label: 'Set', command: CLAUDE_AUTH_FIXES.apiKeyKeychain }];
};

const KEY_SOURCES = {
  env: 'the environment',
  keychain: `the Keychain (${CLAUDE_KEYCHAIN_SERVICE})`,
} as const;

type CompleteFinding = (
  io: CliIo,
  status: ClaudeAuthStatus,
  platform: NodeJS.Platform,
) => Promise<Finding>;

const vertexFinding: CompleteFinding = async (io, _status, platform) => {
  const credentials = adcPath(io, platform);
  if (await isFile(credentials)) {
    return {
      detail: `Vertex env set, application-default credentials at ${credentials}`,
      fixes: [],
    };
  }
  return {
    detail: `Vertex env set, but no application-default credentials at ${credentials}`,
    fixes: [{ label: 'Sign in', command: CLAUDE_AUTH_FIXES.adc }],
  };
};

const COMPLETE_FINDINGS: Record<ClaudeAuthMode, CompleteFinding> = {
  subscription: async () => ({
    detail: 'uses the Claude Code sign-in',
    fixes: [],
  }),
  api_key: async (_io, status) => ({
    detail: `${CLAUDE_API_KEY_ENV} from ${KEY_SOURCES[status.keySource ?? 'env']}`,
    fixes: [],
  }),
  vertex: vertexFinding,
};

const finding = async (
  io: CliIo,
  status: ClaudeAuthStatus,
  platform: NodeJS.Platform,
): Promise<Finding> => {
  if (status.missing.length === 0)
    return COMPLETE_FINDINGS[status.mode](io, status, platform);
  return {
    detail: `${status.missing.join(' and ')} not set`,
    fixes: missingFixes(status, platform),
  };
};

const gatewayText = (status: ClaudeAuthStatus): string => {
  if (!status.gateway) return '';
  return `, through ${CLAUDE_BASE_URL_ENV}`;
};

export const checkClaudeAuth = async (
  io: CliIo,
  options: ClaudeAuthCheckOptions = {},
): Promise<DoctorCheck[]> => {
  const platform = options.platform ?? process.platform;
  try {
    const { status } = await resolveClaudeAuth(authOptions(io, options));
    const found = await finding(io, status, platform);
    return [
      {
        name: CLAUDE_AUTH_CHECK,
        state: `${status.mode} (${sourceText(io, status.source)}), ${found.detail}${gatewayText(status)}`,
        fixes: found.fixes,
      },
    ];
  } catch (err) {
    if (!(err instanceof ClaudeAuthError)) throw err;
    return [
      {
        name: CLAUDE_AUTH_CHECK,
        state: err.message,
        fixes: [{ label: 'Set', command: CLAUDE_AUTH_FIXES.mode }],
      },
    ];
  }
};

export const withClaudeAuthEnv = async (
  io: CliIo,
  options: ClaudeAuthCheckOptions = {},
): Promise<CliIo> => {
  try {
    const { env } = await resolveClaudeAuth(authOptions(io, options));
    if (env.set === undefined) return io;
    return { ...io, env: { ...io.env, ...env.set } };
  } catch (err) {
    if (err instanceof ClaudeAuthError) return io;
    throw err;
  }
};
