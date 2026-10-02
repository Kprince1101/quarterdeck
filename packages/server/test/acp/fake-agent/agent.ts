import {
  agent,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type {
  AgentApp,
  AuthMethod,
  ContentBlock,
} from '@agentclientprotocol/sdk';
import {
  FAKE_AGENT_NAME,
  FAKE_AGENT_VERSION,
  FAKE_AUTH_METHOD_ID,
} from './constants.ts';
import { runScenario } from './scenarios.ts';
import type { FakeAgentOptions } from './types.ts';

interface FakeSession {
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

export const createFakeAgent = (options: FakeAgentOptions = {}): AgentApp => {
  const sessions = new Map<string, FakeSession>();
  const stepDelayMs = options.stepDelayMs ?? 0;
  const state = { authenticated: !options.requireAuth, sessionCount: 0 };

  const findSession = (sessionId: string): FakeSession => {
    const session = sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams({ sessionId }, 'unknown session');
    }
    return session;
  };

  return agent({ name: FAKE_AGENT_NAME })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
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
    .onRequest('session/new', () => {
      if (!state.authenticated) {
        throw RequestError.authRequired({ authMethods: FAKE_AUTH_METHODS });
      }
      state.sessionCount += 1;
      const sessionId = `fake-session-${state.sessionCount}`;
      sessions.set(sessionId, { turn: undefined });
      return { sessionId };
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
