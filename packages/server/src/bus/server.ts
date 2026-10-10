import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { redactShapes } from '../lib/redact.js';
import type { BusCall, BusContext, BusTool } from './tool.js';

export const BUS_SERVER_NAME = 'bus';

export const projectBusName = (project: string): string =>
  `${BUS_SERVER_NAME}-${project}`;

export const BUS_SERVER_INFO = { name: 'quarterdeck-bus', version: '0.0.0' };

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const NO_PROGRESS = (): Promise<void> => Promise.resolve();

const progressOf = (extra: ToolExtra): BusCall['progress'] => {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return NO_PROGRESS;
  let progress = 0;
  return (message) => {
    progress += 1;
    return extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress, message },
    });
  };
};

export const createBusServer = (
  context: BusContext,
  tools: readonly BusTool[],
): McpServer => {
  const server = new McpServer(BUS_SERVER_INFO);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args: Record<string, unknown>, extra: ToolExtra) => {
        const call: BusCall = {
          ...context,
          signal: extra.signal,
          progress: progressOf(extra),
        };
        return {
          content: [
            { type: 'text', text: await tool.run(call, redactShapes(args)) },
          ],
        };
      },
    );
  }
  return server;
};
