import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type {
  AuthMethod,
  RequestPermissionOutcome,
} from '@agentclientprotocol/sdk';
import type {
  ConformanceAdapter,
  ConformanceConnection,
  ConformanceHooks,
  SessionOpening,
} from './conformance/types.ts';
import type { FakeAgentLaunch } from './fake-agent/types.ts';

const AUTH_REQUIRED_CODE = RequestError.authRequired().code;

const isAuthRequired = (error: unknown): boolean =>
  error instanceof RequestError && error.code === AUTH_REQUIRED_CODE;

const cancelledWhenAborted = (
  signal: AbortSignal,
): Promise<RequestPermissionOutcome> =>
  new Promise((resolve) => {
    const settle = () => resolve({ outcome: 'cancelled' });
    if (signal.aborted) {
      settle();
      return;
    }
    signal.addEventListener('abort', settle, { once: true });
  });

const connectReference = async (
  launch: FakeAgentLaunch,
  hooks: ConformanceHooks,
): Promise<ConformanceConnection> => {
  const child = spawn(launch.command, launch.args, {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const turns = new Map<string, AbortController>();
  const turnSignal = (sessionId: string): AbortSignal => {
    const existing = turns.get(sessionId);
    if (existing) return existing.signal;
    const controller = new AbortController();
    turns.set(sessionId, controller);
    return controller.signal;
  };

  const connection = client({ name: 'quarterdeck-reference-adapter' })
    .onNotification('session/update', ({ params }) => {
      hooks.onUpdate(params.sessionId, params.update);
    })
    .onRequest('session/request_permission', async ({ params }) => ({
      outcome: await Promise.race([
        hooks.decidePermission(params),
        cancelledWhenAborted(turnSignal(params.sessionId)),
      ]),
    }))
    .connect(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    );
  const { agent } = connection;

  const initialized = await agent.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const authMethods: AuthMethod[] = initialized.authMethods ?? [];

  const openSession = async (cwd: string): Promise<SessionOpening> => {
    try {
      const { sessionId } = await agent.request('session/new', {
        cwd,
        mcpServers: [],
      });
      return { status: 'ready', sessionId };
    } catch (error) {
      if (isAuthRequired(error))
        return { status: 'auth_required', authMethods };
      throw error;
    }
  };

  const prompt = async (sessionId: string, text: string) => {
    turns.set(sessionId, new AbortController());
    const response = await agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    return response.stopReason;
  };

  const cancel = async (sessionId: string) => {
    turns.get(sessionId)?.abort();
    await agent.notify('session/cancel', { sessionId });
  };

  const close = async () => {
    connection.close();
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  };

  return {
    openSession,
    authenticate: async (methodId) => {
      await agent.request('authenticate', { methodId });
    },
    prompt,
    cancel,
    close,
  };
};

export const REFERENCE_ADAPTER: ConformanceAdapter = {
  name: 'reference SDK client',
  connect: connectReference,
};
