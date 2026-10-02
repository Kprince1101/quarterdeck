import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import type {
  Agent,
  RemoveWorktreeOptions,
  SessionHost,
  WorktreeHost,
} from '../../src/agents/index.js';

export const TIMEOUT = 30_000;

export const openTestStore = (project: string): Promise<Store> =>
  openStore({ project, dataDir: IN_MEMORY });

export const clearAgents = (store: Store): Promise<unknown> =>
  store.db.exec(
    `delete from events; delete from cards; delete from agents;
     update projects set archived_at = null;`,
  );

export interface FakeSessions extends SessionHost {
  opened: string[];
  closed: string[];
  failNext: (message: string) => void;
}

export const fakeSessions = (): FakeSessions => {
  const opened: string[] = [];
  const closed: string[] = [];
  const live = new Set<string>();
  let failure: string | undefined;
  const open = async (agent: Agent): Promise<string> => {
    const message = failure;
    failure = undefined;
    if (message !== undefined) throw new Error(message);
    const sessionId = `session-${agent.name}`;
    opened.push(agent.name);
    live.add(sessionId);
    return sessionId;
  };
  const close = async (sessionId: string): Promise<void> => {
    if (!live.delete(sessionId))
      throw new Error(`unknown session ${sessionId}`);
    closed.push(sessionId);
  };
  const failNext = (message: string) => {
    failure = message;
  };
  return { opened, closed, open, close, failNext };
};

export interface RemovedWorktree {
  path: string;
  force: boolean;
}

export interface FakeWorktrees extends WorktreeHost {
  removed: RemovedWorktree[];
  failNext: (error: Error) => void;
}

export const fakeWorktrees = (): FakeWorktrees => {
  const removed: RemovedWorktree[] = [];
  let failure: Error | undefined;
  const remove = async (
    path: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<void> => {
    const error = failure;
    failure = undefined;
    if (error !== undefined) throw error;
    removed.push({ path, force: options.force ?? false });
  };
  const failNext = (error: Error) => {
    failure = error;
  };
  return { removed, remove, failNext };
};
