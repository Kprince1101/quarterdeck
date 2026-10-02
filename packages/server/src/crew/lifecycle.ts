import {
  createAgentLifecycle,
  gitWorktrees,
  type AgentLifecycle,
  type SessionHost,
} from '../agents/index.js';
import type { Store } from '../store/index.js';
import type { CrewRules } from './rules.js';

export interface CrewLifecycleOptions {
  rules: CrewRules;
  sessions: SessionHost;
  openStores: () => readonly Store[];
}

export const crewLifecycle = (
  options: CrewLifecycleOptions,
): AgentLifecycle => {
  const current = async (): Promise<AgentLifecycle> => {
    const [naming, lifecycle] = await Promise.all([
      options.rules.load('naming'),
      options.rules.load('lifecycle'),
    ]);
    return createAgentLifecycle({
      naming,
      sessions: options.sessions,
      worktrees: gitWorktrees,
      openStores: options.openStores,
      budget: () => Promise.resolve(lifecycle.budget.window),
    });
  };

  return {
    birth: async (request) => (await current()).birth(request),
    retire: async (store, agentId, retireOptions) =>
      (await current()).retire(store, agentId, retireOptions),
    kill: async (store, agentId, controlOptions) =>
      (await current()).kill(store, agentId, controlOptions),
    reset: async (store, agentId, controlOptions) =>
      (await current()).reset(store, agentId, controlOptions),
  };
};
