import { Readable, Writable } from 'node:stream';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type {
  AgentCapabilities,
  AgentContext,
  ContentBlock,
  PromptResponse,
  RequestPermissionResponse,
  SessionId,
} from '@agentclientprotocol/sdk';

interface StubSession {
  cwd: string;
  mcpServers: string[];
}

interface Turn {
  client: AgentContext;
  sessionId: SessionId;
  text: string;
}

const CAPABILITIES: Record<string, AgentCapabilities> = {
  resume: { sessionCapabilities: { resume: {} } },
  load: { loadSession: true },
  none: {},
};

const capabilities = CAPABILITIES[process.argv[2] ?? 'none'] ?? {};
const sessions = new Map<SessionId, StubSession>();
const cancelWaiters = new Map<SessionId, () => void>();
let sessionCount = 0;

const say = (client: AgentContext, sessionId: SessionId, text: string) =>
  client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  });

const firstText = (prompt: ContentBlock[]) => {
  const [block] = prompt;
  if (block?.type === 'text') return block.text;
  return '';
};

const outcomeText = ({ outcome }: RequestPermissionResponse) => {
  if (outcome.outcome === 'selected') return `selected:${outcome.optionId}`;
  return 'cancelled';
};

const waitForCancel = (sessionId: SessionId) =>
  new Promise<void>((resolve) => {
    cancelWaiters.set(sessionId, resolve);
  });

const askPermission = async ({ client, sessionId }: Turn) => {
  const response = await client.request(
    methods.client.session.requestPermission,
    {
      sessionId,
      toolCall: { toolCallId: 'tool-1', title: 'Write file' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  );
  const text = outcomeText(response);
  await say(client, sessionId, text);
  if (text === 'cancelled') return { stopReason: 'cancelled' as const };
  return { stopReason: 'end_turn' as const };
};

const SCRIPTS: Record<string, (turn: Turn) => Promise<PromptResponse>> = {
  describe: async ({ client, sessionId }) => {
    await say(client, sessionId, JSON.stringify(sessions.get(sessionId)));
    return { stopReason: 'end_turn' };
  },
  ask: askPermission,
  hang: async ({ client, sessionId }) => {
    const cancelled = waitForCancel(sessionId);
    await say(client, sessionId, 'waiting');
    await cancelled;
    return { stopReason: 'cancelled' };
  },
  crash: async () => {
    process.exit(3);
  },
};

const echo = async ({ client, sessionId, text }: Turn) => {
  await say(client, sessionId, 'echo:');
  await say(client, sessionId, text);
  return { stopReason: 'end_turn' as const };
};

const replayHistory = (client: AgentContext, sessionId: SessionId) =>
  client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'earlier prompt' },
    },
  });

const serve = () => {
  agent({ name: 'stub-agent' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: capabilities,
      agentInfo: { name: 'stub-agent', version: '0.0.0' },
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      sessionCount += 1;
      const sessionId = `stub-session-${sessionCount}`;
      sessions.set(sessionId, {
        cwd: params.cwd,
        mcpServers: params.mcpServers.map((server) => server.name),
      });
      return { sessionId };
    })
    .onRequest(methods.agent.session.resume, () => ({}))
    .onRequest(methods.agent.session.load, async ({ client, params }) => {
      await replayHistory(client, params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.prompt, ({ client, params }) => {
      const text = firstText(params.prompt);
      const script = SCRIPTS[text] ?? echo;
      return script({ client, sessionId: params.sessionId, text });
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      cancelWaiters.get(params.sessionId)?.();
      cancelWaiters.delete(params.sessionId);
    })
    .connect(
      ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin),
      ),
    );
};

const keepAlive = () => {
  setInterval(() => {}, 1_000);
};

const BEHAVIORS: Record<string, () => void> = {
  serve,
  silent: keepAlive,
  linger: () => {
    keepAlive();
    serve();
  },
  'ignore-sigterm': () => {
    process.on('SIGTERM', () => {});
    keepAlive();
    serve();
  },
};

(BEHAVIORS[process.argv[3] ?? 'serve'] ?? serve)();
process.stderr.write('stub agent ready\n');
