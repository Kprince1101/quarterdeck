import type { AgentCommand } from '../client/types.js';
import { runCommand } from './run.js';
import type { RunOptions } from './run.js';

export const DEFAULT_VERSION_TIMEOUT_MS = 10_000;

export interface VersionProbe {
  version: string | null;
  error?: string;
}

export type ProbeOptions = RunOptions;

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? '';

const failed = (error: string): VersionProbe => ({ version: null, error });

const readOutput = (stdout: string, stderr: string): VersionProbe => {
  const version = firstLine(stdout) || firstLine(stderr);
  if (version) return { version };
  return failed('printed no version');
};

export const probeAgentVersion = async (
  command: AgentCommand,
  options: ProbeOptions,
): Promise<VersionProbe> => {
  const result = await runCommand(command, options);
  if (result.status === 'failed') return failed(result.error);
  if (result.code === 0) return readOutput(result.stdout, result.stderr);
  return failed(`exited with ${result.code ?? result.signal}`);
};
