import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { quarterdeckHome } from '../../../store/paths.js';

export const GEMINI_SYSTEM_SETTINGS_ENV = 'GEMINI_CLI_SYSTEM_SETTINGS_PATH';
export const GEMINI_TRUST_WORKSPACE_ENV = 'GEMINI_CLI_TRUST_WORKSPACE';

export const GEMINI_SYSTEM_SETTINGS = {
  general: { defaultApprovalMode: 'default' },
  tools: { allowed: [] },
  security: {
    disableYoloMode: true,
    disableAlwaysAllow: true,
    enablePermanentToolApproval: false,
  },
  hooksConfig: { enabled: false },
  advanced: { ignoreLocalEnv: true },
} as const;

export const GEMINI_ADMIN_POLICY = [
  '# Written by Quarterdeck before every gemini launch. Every tool call asks',
  '# the ACP client, which answers from the project rules.',
  '',
  '# argsPattern keeps the known-safe shell heuristic from turning ask into allow.',
  '[[rule]]',
  'toolName = "run_shell_command"',
  'argsPattern = ".*"',
  'decision = "ask_user"',
  'priority = 999',
  '',
  '[[rule]]',
  'toolName = "*"',
  'decision = "ask_user"',
  'priority = 998',
  '',
].join('\n');

export interface GeminiPaths {
  dir: string;
  systemSettings: string;
  adminPolicy: string;
}

export const defaultGeminiDir = (home: string = quarterdeckHome()): string =>
  join(home, 'gemini');

export const geminiPaths = (dir: string): GeminiPaths => ({
  dir,
  systemSettings: join(dir, 'system-settings.json'),
  adminPolicy: join(dir, 'admin-policy.toml'),
});

export const geminiSystemConfigDir = (os: NodeJS.Platform = platform()) => {
  if (os === 'darwin') return '/Library/Application Support/GeminiCli';
  if (os === 'win32') return 'C:\\ProgramData\\gemini-cli';
  return '/etc/gemini-cli';
};

export type GeminiAdminPolicySource =
  'env' | 'system_settings' | 'system_policies';

export const GEMINI_ADMIN_POLICY_CARD = 'gemini.admin_policy';

export class GeminiAdminPolicyError extends Error {
  readonly cardKind = GEMINI_ADMIN_POLICY_CARD;
  readonly source: GeminiAdminPolicySource;
  readonly path: string;

  constructor(source: GeminiAdminPolicySource, path: string) {
    super(
      `Gemini CLI has an administrator policy at ${path} (${source}). ` +
        'Quarterdeck will not replace it or run gemini under it.',
    );
    this.name = 'GeminiAdminPolicyError';
    this.source = source;
    this.path = path;
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const policyFiles = (dir: string) =>
  readdir(dir).then(
    (names) => names.filter((name) => name.endsWith('.toml')),
    (): string[] => [],
  );

export const assertNoAdminPolicy = async (
  env: NodeJS.ProcessEnv,
  systemConfigDir: string,
  paths: GeminiPaths,
): Promise<void> => {
  const envPath = env[GEMINI_SYSTEM_SETTINGS_ENV];
  if (envPath && envPath !== paths.systemSettings) {
    throw new GeminiAdminPolicyError('env', envPath);
  }
  const settings = join(systemConfigDir, 'settings.json');
  if (await exists(settings)) {
    throw new GeminiAdminPolicyError('system_settings', settings);
  }
  const policies = join(systemConfigDir, 'policies');
  const [policy] = await policyFiles(policies);
  if (policy) {
    throw new GeminiAdminPolicyError('system_policies', join(policies, policy));
  }
};

export const writeGeminiLockdown = async (paths: GeminiPaths) => {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.systemSettings,
    `${JSON.stringify(GEMINI_SYSTEM_SETTINGS, null, 2)}\n`,
  );
  await writeFile(paths.adminPolicy, GEMINI_ADMIN_POLICY);
};

export const geminiLockdownEnv = (
  paths: GeminiPaths,
): Record<string, string> => ({
  [GEMINI_SYSTEM_SETTINGS_ENV]: paths.systemSettings,
  [GEMINI_TRUST_WORKSPACE_ENV]: 'false',
});
