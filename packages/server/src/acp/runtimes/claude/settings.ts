import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage, hasErrorCode } from '../../../lib/errors.js';

export const CLAUDE_PERMISSION_SETTINGS = 'claude_permission_settings';

const DEFAULT_MODES = new Set(['default', 'manual']);

export type ClaudeSettingsTier = 'user' | 'project' | 'local';

export type ClaudeSettingsKind = 'allow' | 'default_mode' | 'unreadable';

export interface ClaudeSettingsOverride {
  path: string;
  tier: ClaudeSettingsTier;
  kind: ClaudeSettingsKind;
  reason: string;
}

export interface ClaudeSettingsFile {
  path: string;
  tier: ClaudeSettingsTier;
}

export class ClaudePermissionSettingsError extends Error {
  readonly code = CLAUDE_PERMISSION_SETTINGS;
  readonly overrides: ClaudeSettingsOverride[];

  constructor(overrides: ClaudeSettingsOverride[]) {
    const listed = overrides
      .map(({ path, reason }) => `${path}: ${reason}`)
      .join('; ');
    super(
      `Claude settings would answer permission requests before the project's rules. ${listed}`,
    );
    this.name = 'ClaudePermissionSettingsError';
    this.overrides = overrides;
  }
}

export const claudeSettingsFiles = (
  cwd: string,
  env: NodeJS.ProcessEnv,
): ClaudeSettingsFile[] => {
  const configDir = env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  return [
    { path: join(configDir, 'settings.json'), tier: 'user' },
    { path: join(cwd, '.claude', 'settings.json'), tier: 'project' },
    { path: join(cwd, '.claude', 'settings.local.json'), tier: 'local' },
  ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Finding {
  kind: ClaudeSettingsKind;
  reason: string;
}

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return undefined;
    throw err;
  }
};

const permissionFindings = (settings: unknown): Finding[] => {
  if (!isRecord(settings)) {
    return [{ kind: 'unreadable', reason: 'not a JSON object' }];
  }
  const permissions = settings['permissions'];
  if (!isRecord(permissions)) return [];
  const findings: Finding[] = [];
  const allow = permissions['allow'];
  if (Array.isArray(allow) && allow.length > 0) {
    findings.push({
      kind: 'allow',
      reason: `permissions.allow has ${allow.length} rule(s)`,
    });
  }
  const mode = permissions['defaultMode'];
  if (mode !== undefined && !DEFAULT_MODES.has(String(mode).toLowerCase())) {
    findings.push({
      kind: 'default_mode',
      reason: `permissions.defaultMode is ${JSON.stringify(mode)}`,
    });
  }
  return findings;
};

const settingsFindings = (text: string): Finding[] => {
  try {
    return permissionFindings(JSON.parse(text));
  } catch (err) {
    return [
      {
        kind: 'unreadable',
        reason: `not valid JSON (${getErrorMessage(err)})`,
      },
    ];
  }
};

export const findClaudeSettingsOverrides = async (
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeSettingsOverride[]> => {
  const found = await Promise.all(
    claudeSettingsFiles(cwd, env).map(async ({ path, tier }) => {
      const text = await readText(path);
      if (text === undefined) return [];
      return settingsFindings(text).map((finding) => ({
        path,
        tier,
        ...finding,
      }));
    }),
  );
  return found.flat();
};

export const isRepoAllowOverride = ({
  tier,
  kind,
}: ClaudeSettingsOverride): boolean =>
  tier !== 'user' && kind !== 'default_mode';
