import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BusContext, BusTool } from './tool.js';

export const BUS_SERVER_NAME = 'bus';

export const BUS_SERVER_INFO = { name: 'quarterdeck-bus', version: '0.0.0' };

export const createBusServer = (
  context: BusContext,
  tools: readonly BusTool[],
): McpServer => {
  const server = new McpServer(BUS_SERVER_INFO);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args: Record<string, unknown>) => ({
        content: [{ type: 'text', text: await tool.run(context, args) }],
      }),
    );
  }
  return server;
};
