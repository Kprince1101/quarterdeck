import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ACP_SRC = fileURLToPath(new URL('../../src/acp', import.meta.url));
const ENV_MODULE = 'env.ts';

const SPREAD = /\.\.\.\s*\(?\s*process\.env\b/;
const FALLBACK = /(\?\?|\|\|)\s*\(?\s*process\.env\b/;
const WHOLE = /process\.env(?![\w$.[])/;

const sources = async (): Promise<string[]> => {
  const entries = await readdir(ACP_SRC, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
};

const offending = async (pattern: RegExp, allowed: readonly string[] = []) => {
  const found: string[] = [];
  for (const path of await sources()) {
    const name = relative(ACP_SRC, path);
    if (allowed.includes(name)) continue;
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (pattern.test(line))
        found.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
};

describe('packages/server/src/acp', () => {
  it('has sources to check', async () => {
    expect((await sources()).map((path) => relative(ACP_SRC, path))).toContain(
      ENV_MODULE,
    );
  });

  it('never spreads process.env', async () => {
    expect(await offending(SPREAD)).toEqual([]);
  });

  it('never falls back to process.env', async () => {
    expect(await offending(FALLBACK)).toEqual([]);
  });

  it('hands process.env as a whole only to childEnv', async () => {
    expect(await offending(WHOLE, [ENV_MODULE])).toEqual([]);
  });

  it('gives every spawn an env from childEnv', async () => {
    const counts: Record<string, { spawns: number; envs: number }> = {};
    for (const path of await sources()) {
      const text = await readFile(path, 'utf8');
      const spawns = text.match(/\bspawn(Sync)?\(/g)?.length ?? 0;
      if (spawns === 0) continue;
      const envs = text.match(/\benv: childEnv\(/g)?.length ?? 0;
      counts[relative(ACP_SRC, path)] = { spawns, envs };
    }
    expect(Object.keys(counts).length).toBeGreaterThan(0);
    expect(
      Object.entries(counts).filter(([, count]) => count.envs !== count.spawns),
    ).toEqual([]);
  });
});
