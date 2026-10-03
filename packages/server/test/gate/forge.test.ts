import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { RulesError, UnknownForgeError } from '@quarterdeck/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ForgeUnavailableError,
  forgeHost,
  repoForge,
  repositoryForge,
} from '../../src/gate/index.js';

const exec = promisify(execFile);

const writeForges = async (dir: string, forges: unknown): Promise<string> => {
  await mkdir(resolve(dir, '.quarterdeck'), { recursive: true });
  const path = resolve(dir, '.quarterdeck', 'rules.local.forges.json');
  await writeFile(path, JSON.stringify({ forges }));
  return path;
};

describe('project forge', () => {
  let root = '';
  let homeDir = '';
  let repo = '';

  const withOrigin = async (origin: string): Promise<string> => {
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
    return repo;
  };

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'quarterdeck-forge-'));
    homeDir = resolve(root, 'home');
    repo = resolve(root, 'repo');
    await mkdir(homeDir);
    await exec('git', ['init', '-q', repo]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('detects GitHub from a github.com origin', async () => {
    await withOrigin('git@github.com:example-org/quarterdeck.git');
    expect(await repoForge(repo, { homeDir })).toBe('github');
  });

  it('detects GitLab from a gitlab.com origin', async () => {
    await withOrigin('https://gitlab.com/example-org/quarterdeck.git');
    expect(await repoForge(repo, { homeDir })).toBe('gitlab');
  });

  it('detects a self-hosted host mapped in the home layer', async () => {
    await writeForges(homeDir, { 'git.example.org': 'gitlab' });
    await withOrigin('ssh://git@git.example.org/example-org/quarterdeck.git');

    expect(await repoForge(repo, { homeDir })).toBe('gitlab');
  });

  it('names an unmapped host and the setting to add', async () => {
    await withOrigin('https://git.example.org/example-org/quarterdeck.git');

    const detecting = repoForge(repo, { homeDir });

    await expect(detecting).rejects.toThrow(UnknownForgeError);
    await expect(repoForge(repo, { homeDir })).rejects.toThrow(
      'git.example.org is not a forge Quarterdeck knows; map it in ~/.quarterdeck/rules.local.forges.json',
    );
  });

  it('refuses a mapping the repository sets for itself', async () => {
    await withOrigin('https://git.example.org/example-org/quarterdeck.git');
    const path = await writeForges(repo, { 'git.example.org': 'gitlab' });

    await expect(repoForge(repo, { homeDir })).rejects.toThrow(RulesError);
    await expect(repoForge(repo, { homeDir })).rejects.toThrow(path);
  });

  it('refuses a repo mapping even when there is no origin to read', async () => {
    const path = await writeForges(repo, { 'git.example.org': 'gitlab' });

    await expect(repoForge(repo, { homeDir })).rejects.toThrow(path);
  });

  it('detects GitLab from an origin in a nested group', async () => {
    await withOrigin('git@gitlab.com:group/subgroup/quarterdeck.git');
    expect(await repoForge(repo, { homeDir })).toBe('gitlab');
  });

  it('keeps GitHub wording where there is no origin to read', async () => {
    expect(await repoForge(null, { homeDir })).toBe('github');
    expect(await repoForge(repo, { homeDir })).toBe('github');
  });

  it('reads the mapping for a repository it is handed', async () => {
    await writeForges(homeDir, { 'git.example.org': 'gitlab' });
    const repository = {
      hostname: 'git.example.org',
      owner: 'example-org',
      name: 'quarterdeck',
    };

    expect(await repositoryForge(repository, { homeDir })).toBe('gitlab');
  });
});

describe('forge host', () => {
  it('puts GitHub on the gh CLI', () => {
    expect(forgeHost('github').forge).toBe('github');
  });

  it('has no GitLab host yet', () => {
    expect(() => forgeHost('gitlab')).toThrow(ForgeUnavailableError);
    expect(() => forgeHost('gitlab')).toThrow('GitLab forge not available yet');
  });
});
