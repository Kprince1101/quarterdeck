import {
  agent,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type {
  AgentApp,
  AgentCapabilities,
  AgentContext,
  AuthMethod,
  ContentBlock,
} from '@agentclientprotocol/sdk';
import {
  FAKE_AGENT_NAME,
  FAKE_AGENT_VERSION,
  FAKE_AUTH_METHOD_ID,
  FAKE_HISTORY_TEXT,
} from './constants.ts';
import { runScenario } from './scenarios.ts';
import type {
  FakeAgentHooks,
  FakeAgentOptions,
  FakeSessionSetup,
} from './types.ts';

interface FakeSession {
  setup: FakeSessionSetup;
  turn: AbortController | undefined;
}

export const FAKE_AUTH_METHODS: AuthMethod[] = [
  {
    id: FAKE_AUTH_METHOD_ID,
    name: 'Fake login',
    description: 'Signs the fake agent in without leaving the process.',
  },
];

const promptText = (prompt: ContentBlock[]): string =>
  prompt
    .flatMap((block) => {
      if (block.type === 'text') return [block.text];
      return [];
    })
    .join('');

const fakeCapabilities = (options: FakeAgentOptions): AgentCapabilities => {
  const capabilities: AgentCapabilities = {
    loadSession: options.supportsLoad ?? false,
  };
  if (options.supportsResume) {
    capabilities.sessionCapabilities = { resume: {} };
  }
  return capabilities;
};

const refuseCrashInProcess = () => {
  throw RequestError.internalError(
    undefined,
    'crash needs the fake agent running as its own process',
  );
};

const replayHistory = (client: AgentContext, sessionId: string) =>
  client.notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: FAKE_HISTORY_TEXT },
    },
  });

const requireSupport = (supported: boolean | undefined, method: string) => {
  if (!supported) throw RequestError.methodNotFound(method);
};

export const createFakeAgent = (
  options: FakeAgentOptions = {},
  hooks: FakeAgentHooks = {},
): AgentApp => {
  const sessions = new Map<string, FakeSession>();
  const stepDelayMs = options.stepDelayMs ?? 0;
  const exitProcess = hooks.exitProcess ?? refuseCrashInProcess;
  const state = { authenticated: !options.requireAuth, sessionCount: 0 };

  const findSession = (sessionId: string): FakeSession => {
    const session = sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams({ sessionId }, 'unknown session');
    }
    return session;
  };

  const restoreSession = (sessionId: string, setup: FakeSessionSetup) => {
    sessions.set(sessionId, {
      setup: { cwd: setup.cwd, mcpServers: setup.mcpServers },
      turn: undefined,
    });
  };

  return agent({ name: FAKE_AGENT_NAME })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: fakeCapabilities(options),
      authMethods: FAKE_AUTH_METHODS,
      agentInfo: { name: FAKE_AGENT_NAME, version: FAKE_AGENT_VERSION },
    }))
    .onRequest('authenticate', ({ params }) => {
      if (params.methodId !== FAKE_AUTH_METHOD_ID) {
        throw RequestError.invalidParams(
          { methodId: params.methodId },
          'unknown auth method',
        );
      }
      state.authenticated = true;
      return {};
    })
    .onRequest('session/new', ({ params }) => {
      if (!state.authenticated) {
        throw RequestError.authRequired({ authMethods: FAKE_AUTH_METHODS });
      }
      state.sessionCount += 1;
      const sessionId = `fake-session-${state.sessionCount}`;
      restoreSession(sessionId, params);
      return { sessionId };
    })
    .onRequest('session/resume', ({ params }) => {
      requireSupport(options.supportsResume, 'session/resume');
      restoreSession(params.sessionId, {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      });
      return {};
    })
    .onRequest('session/load', async ({ params, client }) => {
      requireSupport(options.supportsLoad, 'session/load');
      restoreSession(params.sessionId, params);
      await replayHistory(client, params.sessionId);
      return {};
    })
    .onRequest('session/prompt', async ({ params, client, signal }) => {
      const session = findSession(params.sessionId);
      session.turn?.abort();
      const turn = new AbortController();
      session.turn = turn;
      try {
        const stopReason = await runScenario({
          sessionId: params.sessionId,
          text: promptText(params.prompt),
          client,
          signal: AbortSignal.any([signal, turn.signal]),
          stepDelayMs,
          setup: session.setup,
          exitProcess,
        });
        return { stopReason };
      } finally {
        if (session.turn === turn) session.turn = undefined;
      }
    })
    .onNotification('session/cancel', ({ params }) => {
      sessions.get(params.sessionId)?.turn?.abort();
    });
};
