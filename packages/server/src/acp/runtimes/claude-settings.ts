import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage, hasErrorCode } from '../../lib/errors.js';

export const CLAUDE_PERMISSION_SETTINGS = 'claude_permission_settings';

const DEFAULT_MODES = new Set(['default', 'manual']);

export interface ClaudeSettingsOverride {
  path: string;
  reason: string;
}

export class ClaudePermissionSettingsError extends Error {
  readonly code = CLAUDE_PERMISSION_SETTINGS;
  readonly overrides: ClaudeSettingsOverride[];

  constructor(overrides: ClaudeSettingsOverride[]) {
    const listed = overrides
      .map(({ path, reason }) => `${path}: ${reason}`)
      .join('; ');
    super(
      `Claude settings would answer permission requests before the project's rules, and this agent command cannot be told to ignore them. ${listed}`,
    );
    this.name = 'ClaudePermissionSettingsError';
    this.overrides = overrides;
  }
}

export const claudeSettingsPaths = (
  cwd: string,
  env: NodeJS.ProcessEnv,
): string[] => {
  const configDir = env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  return [
    join(configDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return undefined;
    throw err;
  }
};

const permissionReasons = (settings: unknown): string[] => {
  if (!isRecord(settings)) return ['not a JSON object'];
  const permissions = settings['permissions'];
  if (!isRecord(permissions)) return [];
  const reasons: string[] = [];
  const allow = permissions['allow'];
  if (Array.isArray(allow) && allow.length > 0) {
    reasons.push(`permissions.allow has ${allow.length} rule(s)`);
  }
  const mode = permissions['defaultMode'];
  if (mode !== undefined && !DEFAULT_MODES.has(String(mode).toLowerCase())) {
    reasons.push(`permissions.defaultMode is ${JSON.stringify(mode)}`);
  }
  return reasons;
};

const settingsReasons = (text: string): string[] => {
  try {
    return permissionReasons(JSON.parse(text));
  } catch (err) {
    return [`not valid JSON (${getErrorMessage(err)})`];
  }
};

export const findClaudeSettingsOverrides = async (
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeSettingsOverride[]> => {
  const found = await Promise.all(
    claudeSettingsPaths(cwd, env).map(async (path) => {
      const text = await readText(path);
      if (text === undefined) return [];
      return settingsReasons(text).map((reason) => ({
        path,
        reason,
      }));
    }),
  );
  return found.flat();
};
