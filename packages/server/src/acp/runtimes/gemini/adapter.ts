import { win32 } from 'node:path';
import type { AcpClient, AgentCommand } from '../../client/types.js';
import { childEnv, withChildEnv, type ChildEnvSpec } from '../../env.js';
import { launchAcpClient } from '../../launch/launch.js';
import type { AgentLaunch, LaunchOptions } from '../../launch/launch.js';
import type {
  RuntimeAdapter,
  RuntimeAdapterSpec,
  RuntimeLaunch,
} from '../adapter.js';
import {
  assertNoAdminPolicy,
  defaultGeminiDir,
  GEMINI_SYSTEM_SETTINGS_ENV,
  geminiLockdownEnv,
  geminiPaths,
  geminiSystemConfigDir,
  writeGeminiLockdown,
} from './lockdown.js';

export const GEMINI_COMMAND = 'gemini';

export const GEMINI_ARGS: readonly string[] = [
  '--acp',
  '--approval-mode',
  'default',
];

const ADMIN_POLICY_FLAG = '--admin-policy';
const GEMINI_BIN = /^gemini(\.(cmd|exe|ps1))?$/i;

export const GEMINI_PASS_ENV: readonly string[] = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_USE_VERTEXAI',
];

export interface GeminiAdapterOptions {
  dir?: string;
  systemConfigDir?: string;
}

const launchEnv = (launch: RuntimeLaunch): ChildEnvSpec | undefined =>
  launch.command?.env ?? launch.env;

const adminPolicyEnv = (launch: RuntimeLaunch) =>
  childEnv(
    withChildEnv(launchEnv(launch), { pass: [GEMINI_SYSTEM_SETTINGS_ENV] }),
  );

export const isGeminiCommand = (command: string): boolean =>
  GEMINI_BIN.test(win32.basename(command));

export const createGeminiAdapter = ({
  dir = defaultGeminiDir(),
  systemConfigDir = geminiSystemConfigDir(),
}: GeminiAdapterOptions = {}): RuntimeAdapter => {
  const paths = geminiPaths(dir);
  const adminPolicyArgs = [ADMIN_POLICY_FLAG, paths.adminPolicy];

  const inGeminiDir = (env: ChildEnvSpec | undefined) => ({
    cwd: dir,
    env: withChildEnv(env, {
      pass: GEMINI_PASS_ENV,
      set: geminiLockdownEnv(paths),
    }),
  });

  const spec: RuntimeAdapterSpec = {
    runtime: 'gemini',
    displayName: 'Gemini CLI',
    passEnv: GEMINI_PASS_ENV,
    command: (launch: RuntimeLaunch) => ({
      command: GEMINI_COMMAND,
      args: [...GEMINI_ARGS, ...adminPolicyArgs],
      ...inGeminiDir(launch.env),
    }),
  };

  const overrideArgs = ({ command, args }: AgentCommand): string[] => {
    if (!isGeminiCommand(command)) return args;
    return [...args, ...adminPolicyArgs];
  };

  const geminiCommand = (launch: RuntimeLaunch): AgentCommand => {
    if (!launch.command) return spec.command(launch);
    return {
      ...launch.command,
      args: overrideArgs(launch.command),
      ...inGeminiDir(launchEnv(launch)),
    };
  };

  const agentLaunch = (launch: RuntimeLaunch): AgentLaunch => {
    const command = geminiCommand(launch);
    return { command, version: { ...command, args: ['--version'] } };
  };

  const connect = async (
    launch: RuntimeLaunch,
    options: LaunchOptions,
  ): Promise<AcpClient> => {
    await assertNoAdminPolicy(adminPolicyEnv(launch), systemConfigDir, paths);
    await writeGeminiLockdown(paths);
    return launchAcpClient(agentLaunch(launch), options);
  };

  return { ...spec, passEnv: GEMINI_PASS_ENV, connect };
};

export const GEMINI_ADAPTER: RuntimeAdapter = createGeminiAdapter();
