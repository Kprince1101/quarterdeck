import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KiroBaseAgent } from '../../src/acp/runtimes/kiro/base-agent.js';
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

describe('kiro agent config prompt', () => {
  const base: KiroBaseAgent = {
    role: 'builder',
    name: 'everyday',
    path: '/home/example/.kiro/agents/everyday.json',
    source: 'machine',
    config: { prompt: 'Base prompt.' },
    ignored: [],
  };

  it('puts the base prompt first, then Quarterdeck’s', () => {
    expect(
      buildKiroAgentConfig(NAME, [BUS], { base, prompt: 'Quarterdeck prompt.' })
        .prompt,
    ).toBe('Base prompt.\n\nQuarterdeck prompt.');
  });

  it('keeps Quarterdeck’s prompt alone without a base', () => {
    expect(
      buildKiroAgentConfig(NAME, [BUS], { prompt: 'Quarterdeck prompt.' })
        .prompt,
    ).toBe('Quarterdeck prompt.');
  });

  it('adds Quarterdeck’s servers to a base that lists its tools', () => {
    const listed = { ...base, config: { tools: ['read', '@bus'] } };
    expect(buildKiroAgentConfig(NAME, [BUS], { base: listed }).tools).toEqual([
      'read',
      '@bus',
    ]);
  });

  it('refuses a base server named like one of Quarterdeck’s, whatever its transport', () => {
    const events: McpServer = {
      type: 'sse',
      name: 'events',
      url: 'https://events.example/sse',
      headers: [],
    };
    const clashing = {
      ...base,
      config: { mcpServers: { events: { type: 'http', url: 'https://x' } } },
    };
    expect(() =>
      buildKiroAgentConfig(NAME, [BUS, events], { base: clashing }),
    ).toThrow(/named events/);
  });

  it('never lets a builder load mcp.json', () => {
    const loads = { ...base, config: { includeMcpJson: true } };
    expect(
      buildKiroAgentConfig(NAME, [BUS], { base: loads }).includeMcpJson,
    ).toBe(false);
    expect(
      buildKiroAgentConfig(NAME, [BUS], { base: { ...loads, role: 'driver' } })
        .includeMcpJson,
    ).toBe(true);
  });
});

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
