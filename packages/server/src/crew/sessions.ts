import type { AcpClient } from '../acp/client/index.js';
import type { Agent } from '../agents/index.js';
import type { BuilderSessionHost, DriverClient } from '../driver/index.js';
import {
  connectAgentSession,
  type PlannerAdapters,
  type PlannerBus,
} from '../planner/sessions.js';
import type { Store } from '../store/index.js';
import { CrewStoppedError } from './failures.js';
import { cardPermissions } from './permission-card.js';

export interface CrewSessionSite {
  store: Store;
  slug: string;
  bus: PlannerBus;
  adapters: PlannerAdapters;
  repoPath: () => Promise<string>;
  passEnv: () => Promise<readonly string[]>;
  onExit?: (agent: Agent) => void;
}

export interface CrewSessionHost extends BuilderSessionHost {
  driverClient: (agentId: string) => DriverClient;
  closeAll: () => Promise<void>;
}

interface LiveAgent {
  agent: Agent;
  client: AcpClient;
  sessions: Set<string>;
}

export class AgentNotLiveError extends Error {
  readonly agentId: string;

  constructor(agentId: string) {
    super(`agent ${agentId} has no live session in this process`);
    this.name = 'AgentNotLiveError';
    this.agentId = agentId;
  }
}

export class SessionTakenError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, holderId: string) {
    super(
      `the runtime gave session ${sessionId}, which agent ${holderId} already holds`,
    );
    this.name = 'SessionTakenError';
    this.sessionId = sessionId;
  }
}

export const createCrewSessions = (site: CrewSessionSite): CrewSessionHost => {
  const agents = new Map<string, LiveAgent>();
  const owners = new Map<string, string>();
  const stopping = new AbortController();

  const forget = (agentId: string): LiveAgent | undefined => {
    const live = agents.get(agentId);
    if (!live) return undefined;
    agents.delete(agentId);
    for (const sessionId of live.sessions) owners.delete(sessionId);
    return live;
  };

  const stop = async (live: LiveAgent): Promise<void> => {
    try {
      await live.client.close();
    } finally {
      site.bus.revoke(live.agent.id);
    }
  };

  const watchExit = (live: LiveAgent): void => {
    const exited = (): void => {
      if (agents.get(live.agent.id) !== live) return;
      forget(live.agent.id);
      site.bus.revoke(live.agent.id);
      if (!stopping.signal.aborted) site.onExit?.(live.agent);
    };
    live.client.closed.then(exited, exited);
  };

  const connect = async (
    agent: Agent,
  ): Promise<{ live: LiveAgent; sessionId: string }> => {
    const repoPath = await site.repoPath();
    const session = await connectAgentSession(
      {
        store: site.store,
        slug: site.slug,
        repoPath,
        bus: site.bus,
        adapters: site.adapters,
        passEnv: await site.passEnv(),
        cardHuman: cardPermissions({
          store: site.store,
          agent,
          signal: stopping.signal,
        }),
        signInSignal: () => stopping.signal,
      },
      agent,
      agent.worktreePath ?? repoPath,
    );
    const live = {
      agent,
      client: session.client,
      sessions: new Set([session.sessionId]),
    };
    return { live, sessionId: session.sessionId };
  };

  const open = async (agent: Agent): Promise<string> => {
    if (stopping.signal.aborted) throw new CrewStoppedError();
    const previous = forget(agent.id);
    if (previous) await stop(previous);
    const { live, sessionId } = await connect(agent).catch((err: unknown) => {
      site.bus.revoke(agent.id);
      throw err;
    });
    if (stopping.signal.aborted) {
      await stop(live);
      throw new CrewStoppedError();
    }
    const holder = owners.get(sessionId);
    if (holder !== undefined) {
      await stop(live);
      throw new SessionTakenError(sessionId, holder);
    }
    agents.set(agent.id, live);
    owners.set(sessionId, agent.id);
    watchExit(live);
    return sessionId;
  };

  const close = async (sessionId: string): Promise<void> => {
    const agentId = owners.get(sessionId);
    if (agentId === undefined) return;
    owners.delete(sessionId);
    const live = agents.get(agentId);
    if (!live) return;
    live.sessions.delete(sessionId);
    if (live.sessions.size > 0) return;
    agents.delete(agentId);
    await stop(live);
  };

  const client = (sessionId: string): AcpClient | undefined => {
    const agentId = owners.get(sessionId);
    if (agentId === undefined) return undefined;
    return agents.get(agentId)?.client;
  };

  const adopt = (live: LiveAgent, sessionId: string): void => {
    if (agents.get(live.agent.id) !== live) return;
    const holder = owners.get(sessionId);
    if (holder !== undefined && holder !== live.agent.id)
      throw new SessionTakenError(sessionId, holder);
    for (const old of live.sessions) owners.delete(old);
    live.sessions.clear();
    live.sessions.add(sessionId);
    owners.set(sessionId, live.agent.id);
  };

  const driverClient = (agentId: string): DriverClient => {
    const live = agents.get(agentId);
    if (!live) throw new AgentNotLiveError(agentId);
    return {
      agent: live.client.agent,
      prompt: (sessionId, input) => live.client.prompt(sessionId, input),
      subscribe: (listener) => live.client.subscribe(listener),
      newSession: async (setup) => {
        const response = await live.client.newSession(setup);
        adopt(live, response.sessionId);
        return response;
      },
    };
  };

  const closeAll = async (): Promise<void> => {
    stopping.abort();
    const all = [...agents.keys()].flatMap((agentId) => {
      const live = forget(agentId);
      if (!live) return [];
      return [live];
    });
    await Promise.allSettled(all.map(stop));
  };

  return { open, close, client, driverClient, closeAll };
};
