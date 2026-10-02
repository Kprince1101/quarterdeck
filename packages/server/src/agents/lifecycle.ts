import type { BudgetWindow, Naming } from '@quarterdeck/rules';
import { assertLaunchBudget } from '../budget/index.js';
import type { Store } from '../store/index.js';
import type { Agent } from './agent.js';
import { insertAgent, openSession, type BirthRequest } from './birth.js';
import { liveAgentNames, pickAgentName, withNameLock } from './names.js';
import { retireAgent, type RetireOptions } from './retire.js';
import type { SessionHost } from './sessions.js';
import type { WorktreeHost } from './worktrees.js';

export interface AgentLifecycleOptions {
  naming: Naming;
  sessions: SessionHost;
  worktrees: WorktreeHost;
  openStores: () => readonly Store[];
  budget: () => Promise<BudgetWindow>;
  random?: () => number;
  now?: () => Date;
}

export interface AgentLifecycle {
  birth: (request: BirthRequest) => Promise<Agent>;
  retire: (
    store: Store,
    agentId: string,
    options?: RetireOptions,
  ) => Promise<Agent>;
}

export const createAgentLifecycle = (
  options: AgentLifecycleOptions,
): AgentLifecycle => {
  const claimName = (request: BirthRequest): Promise<Agent> =>
    withNameLock(async () => {
      const stores = new Set([request.store, ...options.openStores()]);
      const taken = await liveAgentNames([...stores]);
      const name = pickAgentName(options.naming, taken, options.random);
      return insertAgent(request, name);
    });

  const birth = async (request: BirthRequest): Promise<Agent> => {
    await assertLaunchBudget(request.store, await options.budget(), {
      ticketId: request.ticketId,
      now: options.now?.(),
    });
    return openSession(
      request.store,
      options.sessions,
      await claimName(request),
    );
  };

  const retire = (
    store: Store,
    agentId: string,
    retireOptions?: RetireOptions,
  ): Promise<Agent> => retireAgent(store, options, agentId, retireOptions);

  return { birth, retire };
};
