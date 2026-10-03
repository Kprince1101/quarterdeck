import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { RulesError } from '@quarterdeck/rules';
import {
  createKiroAdapter,
  kiroAgentConfigPath,
  KiroConfigError,
  KiroShadowConfigError,
  type LaunchOptions,
  type RuntimeLaunch,
} from '@quarterdeck/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAgentLaunch } from './fake-agent/launch.ts';

const PROJECT = 'example';
const AGENT = 'otter';
const GENERATED = `quarterdeck-${PROJECT}-${AGENT}`;

const BUS: McpServer = {
  type: 'http',
  name: 'bus',
  url: 'http://127.0.0.1:4317/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer example-bus-token' }],
};

const TODAY = `{
  "name": "${GENERATED}",
  "description": "Quarterdeck agent. Written by Quarterdeck, removed on close.",
  "mcpServers": {
    "bus": {
      "type": "http",
      "url": "http://127.0.0.1:4317/mcp",
      "headers": {
        "Authorization": "Bearer example-bus-token"
      }
    }
  },
  "tools": [
    "*"
  ],
  "allowedTools": [],
  "includeMcpJson": false
}
`;

const TRACKER = {
  command: 'tracker-mcp',
  args: ['--stdio'],
  env: { TRACKER_URL: 'https://tracker.example' },
};

const BASE_AGENT = {
  name: 'everyday',
  description: 'The agent I use every day',
  prompt: 'You follow the team conventions.',
  mcpServers: { tracker: TRACKER },
  tools: ['read', 'write', 'shell', '@tracker'],
  allowedTools: ['read', '@tracker/list_items'],
  toolsSettings: { shell: { allowedCommands: ['ls'] } },
  resources: [
    'file://steering/**/*.md',
    'file:///etc/example/standards.md',
    'skill://skills/**/SKILL.md',
    { type: 'knowledgeBase', source: 'file://docs', name: 'docs' },
  ],
  model: 'example-model',
  includeMcpJson: true,
  hooks: { agentSpawn: [{ command: 'echo spawned' }] },
};

interface Sandbox {
  root: string;
  home: string;
  repo: string;
  worktree: string;
  agentsDir: string;
  processDir: string;
}

const writeJson = async (path: string, value: unknown): Promise<string> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
};

const kiroRule = (dir: string, value: unknown): Promise<string> =>
  writeJson(join(dir, '.quarterdeck', 'rules.local.kiro.json'), value);

const clientOptions: LaunchOptions = {
  clientName: 'quarterdeck-kiro-base-test',
  clientVersion: '0.0.0',
  spawnRetries: 0,
  onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
};

describe('kiro base agents', () => {
  let box: Sandbox;
  let warnings: string[];

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'qd-kiro-base-'));
    box = {
      root,
      home: join(root, 'home'),
      repo: join(root, 'repo'),
      worktree: join(root, 'worktree'),
      agentsDir: join(root, 'home', '.kiro', 'agents'),
      processDir: join(root, 'process'),
    };
    await mkdir(box.home, { recursive: true });
    await mkdir(box.repo, { recursive: true });
    await mkdir(box.worktree, { recursive: true });
    warnings = [];
  });

  afterEach(async () => {
    await rm(box.root, { recursive: true, force: true });
  });

  const launch = (role?: RuntimeLaunch['role']): RuntimeLaunch => ({
    cwd: box.worktree,
    project: PROJECT,
    agentName: AGENT,
    ...(role && { role }),
    rules: { homeDir: box.home, repoDir: box.repo },
    mcpServers: [BUS],
    command: fakeAgentLaunch(),
  });

  const writtenConfig = async (
    role?: RuntimeLaunch['role'],
  ): Promise<string> => {
    const adapter = createKiroAdapter({
      agentsDir: box.agentsDir,
      processDir: box.processDir,
      warn: (message) => warnings.push(message),
    });
    const client = await adapter.connect(launch(role), clientOptions);
    try {
      return await readFile(
        kiroAgentConfigPath(box.agentsDir, GENERATED),
        'utf8',
      );
    } finally {
      await client.close();
    }
  };

  const connectError = async (
    role: RuntimeLaunch['role'],
  ): Promise<unknown> => {
    const adapter = createKiroAdapter({
      agentsDir: box.agentsDir,
      processDir: box.processDir,
      warn: (message) => warnings.push(message),
    });
    return adapter.connect(launch(role), clientOptions).then(
      async (client) => {
        await client.close();
        return undefined;
      },
      (err: unknown) => err,
    );
  };

  it('writes today’s config byte for byte when no base is set', async () => {
    expect(await writtenConfig()).toBe(TODAY);
    expect(await writtenConfig('builder')).toBe(TODAY);
    expect(await writtenConfig('driver')).toBe(TODAY);
  });

  it('merges the base into the written config, except its hooks', async () => {
    const basePath = await writeJson(
      join(box.agentsDir, 'everyday.json'),
      BASE_AGENT,
    );
    await kiroRule(box.home, { baseAgents: { builder: 'everyday' } });

    const config = JSON.parse(await writtenConfig('builder')) as unknown;

    expect(config).toEqual({
      name: GENERATED,
      description:
        'Quarterdeck agent. Written by Quarterdeck, removed on close.',
      prompt: 'You follow the team conventions.',
      mcpServers: {
        tracker: TRACKER,
        bus: {
          type: 'http',
          url: 'http://127.0.0.1:4317/mcp',
          headers: { Authorization: 'Bearer example-bus-token' },
        },
      },
      tools: ['read', 'write', 'shell', '@tracker', '@bus'],
      allowedTools: ['read', '@tracker/list_items'],
      toolsSettings: { shell: { allowedCommands: ['ls'] } },
      resources: [
        `file://${join(box.agentsDir, 'steering/**/*.md')}`,
        'file:///etc/example/standards.md',
        `skill://${join(box.agentsDir, 'skills/**/SKILL.md')}`,
        {
          type: 'knowledgeBase',
          source: `file://${join(box.agentsDir, 'docs')}`,
          name: 'docs',
        },
      ],
      model: 'example-model',
      includeMcpJson: true,
    });
    expect(config).not.toHaveProperty('hooks');
    expect(warnings).toEqual([
      `Kiro base agent ${basePath} has hooks; Quarterdeck ignored them.`,
    ]);
  });

  it('reads a file:// prompt relative to the base agent', async () => {
    await mkdir(box.agentsDir, { recursive: true });
    await writeFile(join(box.agentsDir, 'prompt.md'), 'Prompt from a file.');
    await writeJson(join(box.agentsDir, 'everyday.json'), {
      prompt: 'file://./prompt.md',
    });
    await kiroRule(box.home, { baseAgents: { reviewer: 'everyday' } });

    const config = JSON.parse(await writtenConfig('reviewer')) as unknown;

    expect(config).toMatchObject({
      prompt: 'Prompt from a file.',
      tools: ['*'],
      allowedTools: [],
      includeMcpJson: false,
    });
  });

  it('takes the project’s builder over the machine’s', async () => {
    await writeJson(join(box.agentsDir, 'everyday.json'), {
      model: 'machine-model',
    });
    await writeJson(join(box.agentsDir, 'library-builder.json'), {
      model: 'global-library-model',
    });
    await writeJson(join(box.repo, '.kiro', 'agents', 'library-builder.json'), {
      model: 'workspace-library-model',
    });
    await kiroRule(box.home, {
      baseAgents: { driver: 'everyday', builder: 'everyday' },
    });
    await kiroRule(box.repo, { baseAgents: { builder: 'library-builder' } });

    expect(JSON.parse(await writtenConfig('builder'))).toMatchObject({
      model: 'workspace-library-model',
    });
    expect(JSON.parse(await writtenConfig('driver'))).toMatchObject({
      model: 'machine-model',
    });
  });

  it('falls back to the global agent when the repo has none', async () => {
    await writeJson(join(box.agentsDir, 'library-builder.json'), {
      model: 'global-library-model',
    });
    await kiroRule(box.repo, { baseAgents: { builder: 'library-builder' } });

    expect(JSON.parse(await writtenConfig('builder'))).toMatchObject({
      model: 'global-library-model',
    });
  });

  it('refuses a project layer that sets the driver or reviewer', async () => {
    const path = await kiroRule(box.repo, {
      baseAgents: { driver: 'everyday' },
    });

    const error = await connectError('builder');

    expect(error).toBeInstanceOf(RulesError);
    expect(String(error)).toContain(path);
  });

  it('names the paths it looked in when the base is missing', async () => {
    await kiroRule(box.home, { baseAgents: { builder: 'nowhere' } });

    const error = await connectError('builder');

    expect(error).toBeInstanceOf(KiroConfigError);
    expect(String(error)).toContain(
      join(box.repo, '.kiro', 'agents', 'nowhere.json'),
    );
    expect(String(error)).toContain(join(box.agentsDir, 'nowhere.json'));
  });

  it.each([
    ['not JSON', '{ nope'],
    ['the wrong shape', JSON.stringify({ allowedTools: 'read' })],
  ])('names the base when it is %s', async (_what, text) => {
    const path = join(box.agentsDir, 'broken.json');
    await mkdir(box.agentsDir, { recursive: true });
    await writeFile(path, text);
    await kiroRule(box.home, { baseAgents: { driver: 'broken' } });

    const error = await connectError('driver');

    expect(error).toBeInstanceOf(KiroConfigError);
    expect(String(error)).toContain(path);
  });

  it('refuses a base server named like the bus', async () => {
    const path = await writeJson(join(box.agentsDir, 'everyday.json'), {
      mcpServers: { bus: TRACKER },
    });
    await kiroRule(box.home, { baseAgents: { builder: 'everyday' } });

    const error = await connectError('builder');

    expect(error).toBeInstanceOf(KiroConfigError);
    expect(String(error)).toContain(path);
    expect(String(error)).toContain('bus');
  });

  it('still refuses a worktree agent that shadows the generated name', async () => {
    await writeJson(join(box.agentsDir, 'everyday.json'), {});
    await kiroRule(box.home, { baseAgents: { builder: 'everyday' } });
    await writeJson(
      join(box.worktree, '.kiro', 'agents', `${GENERATED}.json`),
      { allowedTools: ['*'] },
    );

    expect(await connectError('builder')).toBeInstanceOf(KiroShadowConfigError);
  });

  it('gives the planner no base', async () => {
    await writeJson(join(box.agentsDir, 'everyday.json'), { model: 'x' });
    await kiroRule(box.home, {
      baseAgents: {
        driver: 'everyday',
        reviewer: 'everyday',
        builder: 'everyday',
      },
    });

    expect(await writtenConfig('planner')).toBe(TODAY);
  });
});
