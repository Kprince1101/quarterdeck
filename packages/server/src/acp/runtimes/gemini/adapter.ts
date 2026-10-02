import { win32 } from 'node:path';
import type { AcpClient, AgentCommand } from '../../client/types.js';
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

export interface GeminiAdapterOptions {
  dir?: string;
  systemConfigDir?: string;
}

const launchEnv = (launch: RuntimeLaunch) =>
  launch.command?.env ?? launch.env ?? process.env;

export const isGeminiCommand = (command: string): boolean =>
  GEMINI_BIN.test(win32.basename(command));

export const createGeminiAdapter = ({
  dir = defaultGeminiDir(),
  systemConfigDir = geminiSystemConfigDir(),
}: GeminiAdapterOptions = {}): RuntimeAdapter => {
  const paths = geminiPaths(dir);
  const adminPolicyArgs = [ADMIN_POLICY_FLAG, paths.adminPolicy];

  const inGeminiDir = (env: NodeJS.ProcessEnv) => ({
    cwd: dir,
    env: geminiLockdownEnv(env, paths),
  });

  const spec: RuntimeAdapterSpec = {
    runtime: 'gemini',
    displayName: 'Gemini CLI',
    command: (launch: RuntimeLaunch) => ({
      command: GEMINI_COMMAND,
      args: [...GEMINI_ARGS, ...adminPolicyArgs],
      ...inGeminiDir(launch.env ?? process.env),
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
    await assertNoAdminPolicy(launchEnv(launch), systemConfigDir, paths);
    await writeGeminiLockdown(paths);
    return launchAcpClient(agentLaunch(launch), options);
  };

  return { ...spec, connect };
};

export const GEMINI_ADAPTER: RuntimeAdapter = createGeminiAdapter();
