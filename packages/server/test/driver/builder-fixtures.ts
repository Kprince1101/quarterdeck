import { execFileSync } from 'node:child_process';
import type { AcpClient } from '../../src/acp/client/index.js';
import type { Agent } from '../../src/agents/index.js';
import type { BuilderSessionHost } from '../../src/driver/index.js';

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=quarterdeck',
      '-c',
      'user.email=quarterdeck@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();

export interface OpenedSession {
  agent: string;
  sessionId: string;
  cwd: string | null;
}

export interface FakeBuilderSessions extends BuilderSessionHost {
  opened: OpenedSession[];
  closed: string[];
  failNext: (message: string) => void;
  lose: (sessionId: string) => void;
}

export const fakeBuilderSessions = (client: AcpClient): FakeBuilderSessions => {
  const opened: OpenedSession[] = [];
  const closed: string[] = [];
  const live = new Set<string>();
  let failure: string | undefined;

  const open = async (agent: Agent): Promise<string> => {
    const message = failure;
    failure = undefined;
    if (message !== undefined) throw new Error(message);
    const { sessionId } = await client.newSession({
      cwd: agent.worktreePath ?? '/nowhere',
      mcpServers: [],
    });
    opened.push({ agent: agent.name, sessionId, cwd: agent.worktreePath });
    live.add(sessionId);
    return sessionId;
  };

  const close = async (sessionId: string): Promise<void> => {
    live.delete(sessionId);
    closed.push(sessionId);
  };

  const lookup = (sessionId: string): AcpClient | undefined => {
    if (!live.has(sessionId)) return undefined;
    return client;
  };

  return {
    opened,
    closed,
    open,
    close,
    client: lookup,
    failNext: (message) => {
      failure = message;
    },
    lose: (sessionId) => {
      live.delete(sessionId);
    },
  };
};
