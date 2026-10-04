import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FORGE_TERMS,
  RulesError,
  UnknownForgeError,
  forgeOfHost,
  forgeTerms,
  forgeWording,
  loadRule,
} from '@quarterdeck/rules';

const MAPPED = { 'git.example.org': 'gitlab' } as const;

describe('forge detection', () => {
  it('knows github.com as GitHub and gitlab.com as GitLab', () => {
    expect(forgeOfHost('github.com', {})).toBe('github');
    expect(forgeOfHost('gitlab.com', {})).toBe('gitlab');
    expect(forgeOfHost('GitLab.com', {})).toBe('gitlab');
  });

  it('reads another host from the forges mapping', () => {
    expect(forgeOfHost('git.example.org', MAPPED)).toBe('gitlab');
    expect(forgeOfHost('Git.Example.org', MAPPED)).toBe('gitlab');
    expect(
      forgeOfHost('git.example.org', { 'GIT.example.org': 'github' }),
    ).toBe('github');
  });

  it('names an unmapped host and the setting to add', () => {
    expect(() => forgeOfHost('code.example.net', MAPPED)).toThrow(
      UnknownForgeError,
    );
    expect(() => forgeOfHost('code.example.net', MAPPED)).toThrow(
      'code.example.net is not a forge Quarterdeck knows; map it in ~/.quarterdeck/rules.local.forges.json, for example { "forges": { "code.example.net": "gitlab" } }',
    );
  });

  it('does not take an inherited property for a mapping', () => {
    expect(() => forgeOfHost('constructor', {})).toThrow(UnknownForgeError);
  });
});

describe('forge terms', () => {
  it('says PR on GitHub and MR on GitLab', () => {
    expect(forgeTerms('github')).toEqual({
      short: 'PR',
      long: 'pull request',
      cli: 'gh',
      name: 'GitHub',
    });
    expect(forgeTerms('gitlab')).toEqual({
      short: 'MR',
      long: 'merge request',
      cli: 'glab',
      name: 'GitLab',
    });
  });

  it('rewords pull request text for GitLab, keeping case and plurals', () => {
    const text =
      'Pull requests merge. Open a pull request, then a PR; two PRs. A PR waits. PRINT and APR stay.';

    expect(forgeWording(text, FORGE_TERMS.gitlab)).toBe(
      'Merge requests merge. Open a merge request, then an MR; two MRs. An MR waits. PRINT and APR stay.',
    );
    expect(forgeWording(text, FORGE_TERMS.github)).toBe(text);
  });
});

describe('forges rule', () => {
  let root = '';
  let homeDir = '';
  let repoDir = '';

  const writeLayer = async (dir: string, value: unknown): Promise<string> => {
    await mkdir(resolve(dir, '.quarterdeck'), { recursive: true });
    const path = resolve(dir, '.quarterdeck', 'rules.local.forges.json');
    await writeFile(path, JSON.stringify(value));
    return path;
  };

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'quarterdeck-forges-'));
    homeDir = resolve(root, 'home');
    repoDir = resolve(root, 'repo');
    await mkdir(homeDir);
    await mkdir(repoDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ships an empty mapping', async () => {
    expect(await loadRule('forges', { homeDir, repoDir })).toEqual({
      forges: {},
    });
  });

  it('takes the mapping from the home layer', async () => {
    await writeLayer(homeDir, { forges: MAPPED });

    expect(await loadRule('forges', { homeDir, repoDir })).toEqual({
      forges: MAPPED,
    });
  });

  it('refuses a mapping in the repo layer, naming the file', async () => {
    const path = await writeLayer(repoDir, { forges: MAPPED });

    await expect(loadRule('forges', { homeDir, repoDir })).rejects.toThrow(
      RulesError,
    );
    await expect(loadRule('forges', { homeDir, repoDir })).rejects.toThrow(
      `${path}: the repo layer may not set forges; map hosts in ~/.quarterdeck/rules.local.forges.json`,
    );
  });

  it('refuses a forge it does not know and a host that is not one', async () => {
    const path = await writeLayer(homeDir, {
      forges: { 'git.example.org': 'bitbucket' },
    });
    await expect(loadRule('forges', { homeDir })).rejects.toThrow(path);

    await writeLayer(homeDir, { forges: { 'not a host': 'gitlab' } });
    await expect(loadRule('forges', { homeDir })).rejects.toThrow(path);
  });
});
