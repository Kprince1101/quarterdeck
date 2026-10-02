import type { Runtime } from '@quarterdeck/rules';
import { spawnAcpClient } from '../client/spawn.js';
import type {
  AcpClient,
  AcpClientOptions,
  AgentCommand,
} from '../client/types.js';

export interface RuntimeLaunch {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  agentName?: string;
  command?: AgentCommand;
}

export interface RuntimeAdapter {
  readonly runtime: Runtime;
  readonly displayName: string;
  command: (launch: RuntimeLaunch) => AgentCommand;
  connect: (
    launch: RuntimeLaunch,
    options: AcpClientOptions,
  ) => Promise<AcpClient>;
}

export interface RuntimeAdapterSpec {
  runtime: Runtime;
  displayName: string;
  command: (launch: RuntimeLaunch) => AgentCommand;
}

export const launchSite = ({
  cwd,
  env,
}: RuntimeLaunch): Pick<AgentCommand, 'cwd' | 'env'> => {
  if (env === undefined) return { cwd };
  return { cwd, env };
};

const launchCommand = (
  spec: RuntimeAdapterSpec,
  launch: RuntimeLaunch,
): AgentCommand => {
  if (!launch.command) return spec.command(launch);
  return { ...launchSite(launch), ...launch.command };
};

export const defineRuntimeAdapter = (
  spec: RuntimeAdapterSpec,
): RuntimeAdapter => ({
  ...spec,
  connect: (launch, options) =>
    spawnAcpClient(launchCommand(spec, launch), options),
});
