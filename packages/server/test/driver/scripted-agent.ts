import {
  agent,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type {
  AnyMessage,
  ContentBlock,
  McpServer,
  StopReason,
  Usage,
} from '@agentclientprotocol/sdk';
import {
  connectAcpClient,
  CANCELLED_PERMISSION,
  type AcpClient,
  type PermissionHandler,
} from '../../src/acp/client/index.js';

export interface ScriptedReply {
  chunks?: string[];
  stopReason?: StopReason;
  usage?: Pick<Usage, 'inputTokens' | 'outputTokens'>;
  fail?: string;
  gate?: Promise<void>;
}

export interface ScriptedSession {
  sessionId: string;
  cwd: string;
  mcpServers: McpServer[];
}

export interface ScriptedPrompt {
  sessionId: string;
  text: string;
}

export interface ScriptedAgent {
  client: AcpClient;
  sessions: ScriptedSession[];
  prompts: ScriptedPrompt[];
  maxConcurrent: () => number;
  reply: (...replies: ScriptedReply[]) => void;
}

export const say = (
  text: string,
  extra: ScriptedReply = {},
): ScriptedReply => ({
  chunks: [text],
  ...extra,
});

export const resultText = (result: unknown): string =>
  `Done.\n\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n`;

const promptText = (prompt: ContentBlock[]): string =>
  prompt
    .flatMap((block) => {
      if (block.type === 'text') return [block.text];
      return [];
    })
    .join('');

const withTotal = (usage: ScriptedReply['usage']): Usage | undefined => {
  if (!usage) return undefined;
  return { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
};

export const startScriptedAgent = async (
  onPermissionRequest: PermissionHandler = async () => CANCELLED_PERMISSION,
): Promise<ScriptedAgent> => {
  const sessions: ScriptedSession[] = [];
  const prompts: ScriptedPrompt[] = [];
  const queue: ScriptedReply[] = [];
  const counts = { running: 0, max: 0 };

  const app = agent({ name: 'scripted' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    }))
    .onRequest('session/new', ({ params }) => {
      const sessionId = `scripted-${sessions.length + 1}`;
      sessions.push({
        sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
      });
      return { sessionId };
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      prompts.push({
        sessionId: params.sessionId,
        text: promptText(params.prompt),
      });
      counts.running += 1;
      counts.max = Math.max(counts.max, counts.running);
      try {
        const next = queue.shift();
        if (!next) throw RequestError.internalError(undefined, 'no reply');
        await next.gate;
        for (const text of next.chunks ?? []) {
          await client.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          });
        }
        if (next.fail) throw RequestError.internalError(undefined, next.fail);
        return {
          stopReason: next.stopReason ?? 'end_turn',
          usage: withTotal(next.usage) ?? null,
        };
      } finally {
        counts.running -= 1;
      }
    });

  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  app.connect({ readable: toAgent.readable, writable: toClient.writable });
  const client = await connectAcpClient({
    stream: { readable: toClient.readable, writable: toAgent.writable },
    options: {
      clientName: 'driver-test',
      clientVersion: '0.0.0',
      onPermissionRequest,
    },
  });

  return {
    client,
    sessions,
    prompts,
    maxConcurrent: () => counts.max,
    reply: (...replies) => {
      queue.push(...replies);
    },
  };
};
