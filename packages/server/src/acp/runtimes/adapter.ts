import type { McpServer } from '@agentclientprotocol/sdk';
import type { LoadRulesOptions, Models, Runtime } from '@quarterdeck/rules';
import { spawnAcpClient } from '../client/spawn.js';
import type {
  AcpClient,
  AcpClientOptions,
  AgentCommand,
} from '../client/types.js';
import { withChildEnv, type ChildEnvSpec } from '../env.js';

export interface RuntimeLaunch {
  cwd: string;
  env?: ChildEnvSpec;
  project?: string;
  agentName?: string;
  role?: keyof Models;
  rules?: LoadRulesOptions;
  mcpServers?: McpServer[];
  command?: AgentCommand;
}

export interface RuntimeAdapter {
  readonly runtime: Runtime;
  readonly displayName: string;
  readonly passEnv: readonly string[];
  command: (launch: RuntimeLaunch) => AgentCommand;
  connect: (
    launch: RuntimeLaunch,
    options: AcpClientOptions,
  ) => Promise<AcpClient>;
}

export interface RuntimeAdapterSpec {
  runtime: Runtime;
  displayName: string;
  passEnv?: readonly string[];
  command: (launch: RuntimeLaunch) => AgentCommand;
}

export const launchSite = ({
  cwd,
  env,
}: RuntimeLaunch): Pick<AgentCommand, 'cwd' | 'env'> => {
  if (env === undefined) return { cwd };
  return { cwd, env };
};

export const withPassEnv = (
  command: AgentCommand,
  passEnv: readonly string[],
): AgentCommand => ({
  ...command,
  env: withChildEnv(command.env, { pass: passEnv }),
});

const launchCommand = (
  spec: RuntimeAdapterSpec,
  launch: RuntimeLaunch,
): AgentCommand => {
  if (!launch.command) return spec.command(launch);
  return { ...launchSite(launch), ...launch.command };
};

export const defineRuntimeAdapter = (
  spec: RuntimeAdapterSpec,
): RuntimeAdapter => {
  const passEnv = spec.passEnv ?? [];
  return {
    ...spec,
    passEnv,
    connect: (launch, options) =>
      spawnAcpClient(
        withPassEnv(launchCommand(spec, launch), passEnv),
        options,
      ),
  };
};
