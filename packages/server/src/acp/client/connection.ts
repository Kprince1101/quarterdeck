import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ContentBlock, SessionId, Stream } from '@agentclientprotocol/sdk';
import {
  createInitializeDeadline,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  raceAbort,
} from './deadline.js';
import { createEventHub } from './event-hub.js';
import type { EventHub } from './event-hub.js';
import { createPermissionGate } from './permission-gate.js';
import { resumeSession } from './resume.js';
import type {
  AcpClient,
  AcpClientEvent,
  AcpClientOptions,
  PromptInput,
  ResumeSetup,
  SessionSetup,
} from './types.js';

export interface ConnectParams {
  stream: Stream;
  options: AcpClientOptions;
  events?: EventHub<AcpClientEvent>;
  dispose?: () => Promise<void>;
}

const toContentBlocks = (input: PromptInput): ContentBlock[] => {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  return input;
};

const noop = async () => {};

export const createClientEvents = (
  options: AcpClientOptions,
): EventHub<AcpClientEvent> => {
  const events = createEventHub<AcpClientEvent>(options.onListenerError);
  if (options.onEvent) events.subscribe(options.onEvent);
  return events;
};

export const connectAcpClient = async ({
  stream,
  options,
  events = createClientEvents(options),
  dispose = noop,
}: ConnectParams): Promise<AcpClient> => {
  const permissions = createPermissionGate(options.onPermissionRequest);

  const connection = client({ name: options.clientName })
    .onNotification(methods.client.session.update, ({ params }) => {
      events.emit({
        type: 'session_update',
        sessionId: params.sessionId,
        update: params.update,
      });
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      const response = await permissions.request(params);
      events.emit({
        type: 'permission',
        sessionId: params.sessionId,
        request: params,
        response,
      });
      return response;
    })
    .connect(stream);

  const markClosed = () => {
    permissions.cancelAll();
    events.emit({ type: 'closed' });
  };
  const closed = connection.closed.then(markClosed, markClosed);

  const close = async () => {
    try {
      connection.close();
      await closed;
    } finally {
      await dispose();
    }
  };

  const initialize = async () => {
    const deadline = createInitializeDeadline(
      options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      options.signal,
    );
    try {
      return await raceAbort(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: options.clientName,
            version: options.clientVersion,
          },
        }),
        deadline,
      );
    } catch (err) {
      await close();
      throw err;
    }
  };

  const agent = await initialize();

  const authenticate = async (methodId: string) => {
    await connection.agent.request(methods.agent.authenticate, { methodId });
  };

  const newSession = ({ cwd, mcpServers }: SessionSetup) =>
    connection.agent.request(methods.agent.session.new, { cwd, mcpServers });

  const resume = (setup: ResumeSetup) =>
    resumeSession(connection.agent, agent, setup);

  const prompt = async (sessionId: SessionId, input: PromptInput) => {
    permissions.beginTurn(sessionId);
    const response = await connection.agent.request(
      methods.agent.session.prompt,
      { sessionId, prompt: toContentBlocks(input) },
    );
    events.emit({
      type: 'turn_end',
      sessionId,
      stopReason: response.stopReason,
    });
    return response;
  };

  const cancel = async (sessionId: SessionId) => {
    permissions.cancelTurn(sessionId);
    await connection.agent.notify(methods.agent.session.cancel, { sessionId });
  };

  return {
    agent,
    authenticate,
    newSession,
    resumeSession: resume,
    prompt,
    cancel,
    subscribe: events.subscribe,
    close,
    closed,
  };
};
