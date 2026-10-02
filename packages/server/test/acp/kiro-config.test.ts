import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildKiroAgentConfig,
  kiroAgentConfigPath,
  writeKiroAgentConfig,
} from '../../src/acp/runtimes/kiro/config.js';

const posixOnly = it.skipIf(process.platform === 'win32');

const BUS: McpServer = {
  type: 'http',
  name: 'bus',
  url: 'http://127.0.0.1:4317/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer example-bus-token' }],
};

const NAME = 'quarterdeck-example-builder-1';

describe('kiro agent config file mode', () => {
  let agentsDir = '';

  beforeEach(async () => {
    agentsDir = join(
      await mkdtemp(join(tmpdir(), 'qd-kiro-config-')),
      'agents',
    );
  });

  afterEach(async () => {
    await rm(join(agentsDir, '..'), { recursive: true, force: true });
  });

  posixOnly('writes the config holding the bus token as 0600', async () => {
    const path = await writeKiroAgentConfig(
      agentsDir,
      buildKiroAgentConfig(NAME, [BUS]),
    );
    expect(path).toBe(kiroAgentConfigPath(agentsDir, NAME));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  posixOnly('tightens a leftover loose config when rewriting it', async () => {
    const path = await writeKiroAgentConfig(
      agentsDir,
      buildKiroAgentConfig(NAME, []),
    );
    await writeFile(path, '{}');
    await chmod(path, 0o644);
    await writeKiroAgentConfig(agentsDir, buildKiroAgentConfig(NAME, [BUS]));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
