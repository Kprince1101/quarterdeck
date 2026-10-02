import type { AuthMethod } from '@agentclientprotocol/sdk';
import type { Runtime } from '@quarterdeck/rules';
import {
  trackAgentProcess,
  type Agent,
  type SessionHost,
} from '../agents/index.js';
import type { AcpClient } from '../acp/client/index.js';
import {
  createPermissionPolicy,
  type CardHuman,
} from '../acp/permissions/index.js';
import {
  CLAUDE_ADAPTER,
  GEMINI_ADAPTER,
  KIRO_ADAPTER,
  type RuntimeAdapter,
} from '../acp/runtimes/index.js';
import type { BusHost } from '../bus/index.js';
import { withSignIn, type SignInGate } from '../signin/index.js';
import type { Store } from '../store/index.js';

export type PlannerBus = Pick<BusHost, 'launch' | 'revoke'>;

export type PlannerAdapters = Record<Runtime, Pick<RuntimeAdapter, 'connect'>>;

export const PLANNER_ADAPTERS: PlannerAdapters = {
  kiro: KIRO_ADAPTER,
  claude: CLAUDE_ADAPTER,
  gemini: GEMINI_ADAPTER,
};

export const PLANNER_CLIENT_NAME = 'quarterdeck';
export const PLANNER_CLIENT_VERSION = '0.0.0';

export interface PlannerSession {
  agentId: string;
  sessionId: string;
  client: AcpClient;
}

export interface PlannerSessionSite {
  store: Store;
  slug: string;
  repoPath: string;
  bus: PlannerBus;
  adapters: PlannerAdapters;
  cardHuman: CardHuman;
  signInSignal: () => AbortSignal;
  passEnv?: readonly string[];
}

export interface PlannerSessionHost extends SessionHost {
  current: () => PlannerSession | undefined;
}

export const plannerSignInGate = (
  store: Store,
  agent: Pick<Agent, 'id' | 'runtime'>,
  signal: AbortSignal,
  authMethods: () => readonly AuthMethod[] | undefined,
): SignInGate => ({
  store,
  agentId: agent.id,
  runtime: agent.runtime,
  authMethods,
  signal,
});

const connectOnce = async (
  site: PlannerSessionSite,
  agent: Agent,
  connected: { client?: AcpClient },
): Promise<PlannerSession> => {
  const bus = await site.bus.launch(agent.id);
  const client = await site.adapters[agent.runtime].connect(
    {
      cwd: site.repoPath,
      env: { pass: site.passEnv ?? [] },
      project: site.slug,
      agentName: agent.name,
      mcpServers: [bus],
    },
    {
      clientName: PLANNER_CLIENT_NAME,
      clientVersion: PLANNER_CLIENT_VERSION,
      onPermissionRequest: createPermissionPolicy({
        repoDir: site.repoPath,
        cardHuman: site.cardHuman,
      }),
      onEvent: trackAgentProcess(site.store, agent.id),
    },
  );
  connected.client = client;
  try {
    const { sessionId } = await client.newSession({
      cwd: site.repoPath,
      mcpServers: [bus],
    });
    return { agentId: agent.id, sessionId, client };
  } catch (err) {
    await client.close();
    throw err;
  }
};

const connectPlanner = (
  site: PlannerSessionSite,
  agent: Agent,
): Promise<PlannerSession> => {
  const connected: { client?: AcpClient } = {};
  const gate = plannerSignInGate(
    site.store,
    agent,
    site.signInSignal(),
    () => connected.client?.agent.authMethods,
  );
  return withSignIn(gate, 'session/new', () =>
    connectOnce(site, agent, connected),
  );
};

export const createPlannerSessionHost = (
  site: PlannerSessionSite,
): PlannerSessionHost => {
  let session: PlannerSession | undefined;

  const open = async (agent: Agent): Promise<string> => {
    try {
      session = await connectPlanner(site, agent);
      return session.sessionId;
    } catch (err) {
      site.bus.revoke(agent.id);
      throw err;
    }
  };

  const close = async (sessionId: string): Promise<void> => {
    if (session?.sessionId !== sessionId) return;
    const closing = session;
    session = undefined;
    try {
      await closing.client.close();
    } finally {
      site.bus.revoke(closing.agentId);
    }
  };

  return { open, close, current: () => session };
};
