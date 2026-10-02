import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: { protocolVersion?: string };
}

const marker = process.env['QUARTERDECK_MCP_STUB_MARKER'];

const reply = (id: number | string, body: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
};

const answer = (message: JsonRpcMessage): Record<string, unknown> => {
  if (message.method === 'initialize') {
    if (marker) writeFileSync(marker, 'initialized\n');
    return {
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'quarterdeck-bus-stub', version: '0.0.0' },
      },
    };
  }
  if (message.method === 'tools/list') return { result: { tools: [] } };
  if (message.method === 'ping') return { result: {} };
  return { error: { code: -32601, message: `unknown ${message.method}` } };
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as JsonRpcMessage;
  if (message.id === undefined) return;
  reply(message.id, answer(message));
});
