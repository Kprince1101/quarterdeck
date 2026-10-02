import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUS_TOOLS_DIR, loadBusTools } from '../../src/bus/index.js';
import type { Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  callTool,
  connectClient,
  insertAgent,
  openTestStore,
} from './fixtures.ts';

const ECHO_TOOL = `export default {
  description: 'Echo the text back with the caller agent id.',
  input: {},
  run: async ({ agentId }, args) => agentId + ':' + JSON.stringify(args),
};
`;

describe('bus tool registry', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'quarterdeck-bus-tools-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads every tool in tools/, named after its file', async () => {
    const tools = await loadBusTools(BUS_TOOLS_DIR);

    expect(tools.map((tool) => tool.name)).toEqual(['read', 'status']);
  });

  it(
    'serves a tool added as one new file',
    async () => {
      await writeFile(join(dir, 'echo.js'), ECHO_TOOL);
      await writeFile(join(dir, 'echo.d.ts'), 'export {};\n');
      await writeFile(join(dir, 'README.md'), '# not a tool\n');
      let store: Store | undefined;
      let client: Client | undefined;
      try {
        store = await openTestStore('registry');
        const agentId = await insertAgent(store, store.projectId, 'okapi');
        client = await connectClient(store, agentId, await loadBusTools(dir));

        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(['echo']);
        expect(await callTool(client, 'echo', {})).toEqual({
          text: `${agentId}:{}`,
          isError: false,
        });
      } finally {
        await client?.close();
        await store?.close();
      }
    },
    TIMEOUT,
  );

  it('rejects a module without a tool default export', async () => {
    await writeFile(join(dir, 'broken.js'), 'export const tool = {};\n');

    await expect(loadBusTools(dir)).rejects.toThrow(
      'bus tool broken.js must export default defineBusTool',
    );
  });

  it('rejects two files defining one tool', async () => {
    await writeFile(join(dir, 'echo.js'), ECHO_TOOL);
    await writeFile(join(dir, 'echo.ts'), ECHO_TOOL);

    await expect(loadBusTools(dir)).rejects.toThrow(
      'bus tool echo is defined twice',
    );
  });
});
