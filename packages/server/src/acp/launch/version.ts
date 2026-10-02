import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getErrorMessage } from '../../lib/errors.js';
import type { AgentCommand, AgentVersionEvent } from '../client/types.js';

const run = promisify(execFile);

export const DEFAULT_VERSION_TIMEOUT_MS = 10_000;

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? '';

export const probeAgentVersion = async (
  { command, args, cwd, env }: AgentCommand,
  timeoutMs: number,
): Promise<AgentVersionEvent> => {
  try {
    const { stdout, stderr } = await run(command, args, {
      cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
    });
    const version = firstLine(stdout) || firstLine(stderr);
    if (version) return { type: 'agent_version', command, version };
    return {
      type: 'agent_version',
      command,
      version: null,
      error: 'printed no version',
    };
  } catch (err) {
    return {
      type: 'agent_version',
      command,
      version: null,
      error: getErrorMessage(err),
    };
  }
};
