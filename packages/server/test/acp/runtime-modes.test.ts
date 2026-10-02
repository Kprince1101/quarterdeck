import { chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANCELLED_PERMISSION,
  createClaudeAdapter,
  createGeminiAdapter,
  createKiroAdapter,
  geminiPaths,
} from '@quarterdeck/server';
import type {
  LaunchOptions,
  RuntimeAdapter,
  RuntimeLaunch,
} from '@quarterdeck/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAgentLaunch } from './fake-agent/index.ts';

const TIMEOUT = 30_000;
const posixOnly = it.skipIf(process.platform === 'win32');

const options: LaunchOptions = {
  clientName: 'quarterdeck-test',
  clientVersion: '0.0.0',
  spawnRetries: 0,
  onPermissionRequest: async () => CANCELLED_PERMISSION,
};

const modeOf = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777;

describe('runtime files under ~/.quarterdeck', () => {
  let root = '';

  const launch = (): RuntimeLaunch => {
    const fake = fakeAgentLaunch();
    return {
      cwd: join(root, 'worktree'),
      project: 'example',
      agentName: 'builder-1',
      env: { set: { CLAUDE_CONFIG_DIR: join(root, 'claude-config') } },
      command: { command: fake.command, args: fake.args },
    };
  };

  const connectAndClose = async (adapter: RuntimeAdapter): Promise<void> => {
    const client = await adapter.connect(launch(), options);
    await client.close();
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'qd-runtime-modes-')));
    await mkdir(join(root, 'worktree'));
    await mkdir(join(root, 'claude-config'));
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  posixOnly(
    'claude makes its process dir 0700, tightening a loose one',
    async () => {
      const processDir = join(root, 'claude');
      await mkdir(processDir);
      await chmod(processDir, 0o755);
      await connectAndClose(createClaudeAdapter({ processDir }));
      expect(await modeOf(processDir)).toBe(0o700);
    },
    TIMEOUT,
  );

  posixOnly(
    'kiro makes its process dir 0700',
    async () => {
      const processDir = join(root, 'kiro');
      await connectAndClose(
        createKiroAdapter({ agentsDir: join(root, 'kiro-agents'), processDir }),
      );
      expect(await modeOf(processDir)).toBe(0o700);
    },
    TIMEOUT,
  );

  posixOnly(
    'gemini makes its dir 0700 and its lockdown files 0600',
    async () => {
      const dir = join(root, 'gemini');
      await connectAndClose(
        createGeminiAdapter({
          dir,
          systemConfigDir: join(root, 'no-system-config'),
        }),
      );
      const paths = geminiPaths(dir);
      expect(await modeOf(dir)).toBe(0o700);
      expect(await modeOf(paths.systemSettings)).toBe(0o600);
      expect(await modeOf(paths.adminPolicy)).toBe(0o600);
    },
    TIMEOUT,
  );
});
