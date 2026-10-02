import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_TOKEN_BYTES,
  apiTokenPath,
  bearerToken,
  createApiToken,
  readApiToken,
  removeApiToken,
  startApiServer,
  verifyApiToken,
  writeApiToken,
} from '../../src/api/index.js';
import { INTENT_NAMES, RULES_PATH } from '../../src/intents/index.js';
import { quarterdeckHome } from '../../src/store/index.js';
import { TIMEOUT, bearer, startTestApi, type TestApi } from './harness.js';

const modeOf = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777;

describe('the API token', () => {
  it('is at least 32 random bytes, base64url', () => {
    const token = createApiToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(API_TOKEN_BYTES);
    expect(API_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
    expect(createApiToken()).not.toBe(token);
  });

  it('verifies only the same token', () => {
    const token = createApiToken();
    expect(verifyApiToken(token, token)).toBe(true);
    expect(verifyApiToken(token, undefined)).toBe(false);
    expect(verifyApiToken(token, '')).toBe(false);
    expect(verifyApiToken(token, `${token}x`)).toBe(false);
    expect(verifyApiToken(token, createApiToken())).toBe(false);
  });

  it('reads a Bearer authorization header and nothing else', () => {
    expect(bearerToken({ authorization: 'Bearer abc_-1' })).toBe('abc_-1');
    expect(bearerToken({})).toBeUndefined();
    expect(bearerToken({ authorization: 'Basic abc' })).toBeUndefined();
    expect(bearerToken({ authorization: 'Bearer a b' })).toBeUndefined();
  });

  it('replaces an old file with a new one created 0600', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qd-token-'));
    try {
      await writeFile(apiTokenPath(home), 'stale', { mode: 0o644 });
      const token = createApiToken();
      const path = await writeApiToken(token, home);
      expect(path).toBe(join(home, 'api.token'));
      expect(await modeOf(path)).toBe(0o600);
      expect(await readApiToken(home)).toBe(token);

      await removeApiToken(createApiToken(), home);
      expect(existsSync(path)).toBe(true);
      await removeApiToken(token, home);
      expect(existsSync(path)).toBe(false);
      await removeApiToken(token, home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('the API server token file', { timeout: TIMEOUT }, () => {
  it('writes a new 0600 token each start and removes it on close', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'qd-token-'));
    const home = quarterdeckHome(homeDir);
    try {
      await mkdir(home, { recursive: true });
      await writeFile(apiTokenPath(home), 'stale', { mode: 0o644 });

      const first = await startApiServer({ port: 0, homeDir });
      expect(first.tokenPath).toBe(apiTokenPath(home));
      expect(await modeOf(first.tokenPath)).toBe(0o600);
      expect(await readFile(first.tokenPath, 'utf8')).toBe(first.token);
      await first.close();
      expect(existsSync(first.tokenPath)).toBe(false);

      const second = await startApiServer({ port: 0, homeDir });
      expect(second.token).not.toBe(first.token);
      expect(await readApiToken(home)).toBe(second.token);
      await second.close();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('leaves the file alone when the port is taken', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'qd-token-'));
    const running = await startApiServer({ port: 0, homeDir });
    try {
      await expect(
        startApiServer({ port: running.port, homeDir }),
      ).rejects.toThrow();
      expect(await readApiToken(quarterdeckHome(homeDir))).toBe(running.token);
    } finally {
      await running.close();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe('API routes without the token', { timeout: TIMEOUT }, () => {
  let t: TestApi;

  beforeAll(async () => {
    t = await startTestApi();
    expect(
      (await t.send('project.create', { project: 'example' })).status,
    ).toBe(200);
  }, TIMEOUT);

  afterAll(async () => {
    await t.close();
  });

  const post = (name: string, headers: Record<string, string>) =>
    fetch(`${t.api.url}/api/intents/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ project: 'example' }),
    });

  const refused = async (res: Response) => {
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.text()).toBe('');
  };

  const wrong = [
    {},
    bearer(createApiToken()),
    { authorization: 'Bearer ' },
    { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` },
  ];

  it.each(INTENT_NAMES)('refuses %s with no or a wrong token', async (name) => {
    for (const headers of wrong) {
      await refused(await post(name, headers));
    }
    expect((await post(name, bearer(t.api.token))).status).not.toBe(401);
  });

  it('refuses the rules read and unknown API paths', async () => {
    for (const headers of wrong) {
      await refused(await fetch(`${t.api.url}${RULES_PATH}`, { headers }));
      await refused(await fetch(`${t.api.url}/api/other`, { headers }));
    }
    const rules = await fetch(`${t.api.url}${RULES_PATH}`, {
      headers: bearer(t.api.token),
    });
    expect(rules.status).toBe(200);
  });

  it('works with the token, for writes and reads', async () => {
    const added = await t.send('notebook.add', {
      project: 'example',
      body: 'hello',
    });
    expect(added.status).toBe(200);
    const summary = await t.send('data.summary', { project: 'example' });
    expect(summary.status).toBe(200);
    const turn = await t.send('turn.read', {
      project: 'example',
      turnId: 1,
    });
    expect(turn.status).toBe(404);
  });

  it('still refuses a foreign Origin before the token', async () => {
    const res = await post('notebook.add', {
      ...bearer(t.api.token),
      origin: 'http://evil.example',
    });
    expect(res.status).toBe(403);
  });

  it('serves the dashboard without the token, and never the token', async () => {
    const page = await fetch(`${t.api.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(t.api.token);
  });

  it('refuses wipe.all without the token and wipes nothing', async () => {
    await refused(
      await fetch(`${t.api.url}/api/intents/wipe.all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'wipe everything' }),
      }),
    );
    expect(await t.api.stores.list()).toEqual(['example']);
  });
});
