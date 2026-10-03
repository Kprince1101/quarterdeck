import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RulesError, loadRule, trackerSchema } from '@quarterdeck/rules';

const MCP_TRACKER = {
  kind: 'tracker-mcp',
  how: 'mcp',
  server: 'tracker-mcp',
  notes: 'tickets are stories in the Example board',
};

const CLI_TRACKER = { kind: 'tracker-cli', how: 'cli', command: 'tracker' };

const issuesOf = (value: unknown): string[] =>
  trackerSchema.safeParse(value).error?.issues.map((issue) => issue.message) ??
  [];

describe('tracker schema', () => {
  it('takes a CLI tracker, an MCP tracker and no tracker', () => {
    expect(trackerSchema.parse(CLI_TRACKER)).toEqual(CLI_TRACKER);
    expect(trackerSchema.parse(MCP_TRACKER)).toEqual(MCP_TRACKER);
    expect(trackerSchema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
  });

  it('needs the command or server that matches how', () => {
    expect(issuesOf({ kind: 'tracker-cli', how: 'cli' })).toEqual([
      "how: 'cli' needs a command",
    ]);
    expect(
      issuesOf({ kind: 'tracker-mcp', how: 'mcp', command: 'tracker' }),
    ).toEqual([
      "how: 'mcp' needs a server",
      "how: 'mcp' takes a server, not a command",
    ]);
  });

  it('needs how for any tracker but none', () => {
    expect(issuesOf({ kind: 'tracker-cli' })).toEqual([
      "a tracker-cli tracker needs how: 'cli' or 'mcp'",
    ]);
    expect(issuesOf({ kind: 'none', command: 'tracker' })).toEqual([
      "a command or server needs how: 'cli' or 'mcp'",
    ]);
  });

  it('refuses an empty kind and unknown keys', () => {
    expect(trackerSchema.safeParse({ kind: ' ' }).success).toBe(false);
    expect(trackerSchema.safeParse({ ...CLI_TRACKER, url: 'x' }).success).toBe(
      false,
    );
  });
});

describe('services rule', () => {
  let root = '';
  let homeDir = '';
  let repoDir = '';

  const writeLayer = async (dir: string, value: unknown): Promise<string> => {
    await mkdir(resolve(dir, '.quarterdeck'), { recursive: true });
    const path = resolve(dir, '.quarterdeck', 'rules.local.services.json');
    await writeFile(path, JSON.stringify(value));
    return path;
  };

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'quarterdeck-services-'));
    homeDir = resolve(root, 'home');
    repoDir = resolve(root, 'repo');
    await mkdir(homeDir);
    await mkdir(repoDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ships no project services', async () => {
    expect(await loadRule('services', { homeDir, repoDir })).toEqual({
      projects: {},
    });
  });

  it('takes per-project services from the home layer', async () => {
    const projects = {
      example: { tracker: MCP_TRACKER },
      sample: { tracker: CLI_TRACKER, publishes: true },
    };
    await writeLayer(homeDir, { projects });

    expect(await loadRule('services', { homeDir, repoDir })).toEqual({
      projects,
    });
  });

  it('refuses services in the repo layer, naming the file', async () => {
    const path = await writeLayer(repoDir, { projects: {} });

    await expect(loadRule('services', { homeDir, repoDir })).rejects.toThrow(
      RulesError,
    );
    await expect(loadRule('services', { homeDir, repoDir })).rejects.toThrow(
      `${path}: the repo layer may not set services`,
    );
  });

  it('refuses a bad tracker and a key that is not a project slug', async () => {
    const path = await writeLayer(homeDir, {
      projects: { example: { tracker: { kind: 'tracker-cli', how: 'cli' } } },
    });
    await expect(loadRule('services', { homeDir })).rejects.toThrow(path);

    await writeLayer(homeDir, { projects: { 'Not A Slug': {} } });
    await expect(loadRule('services', { homeDir })).rejects.toThrow(path);
  });
});
