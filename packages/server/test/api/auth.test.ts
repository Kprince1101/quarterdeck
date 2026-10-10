import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { authReadResultSchema } from '../../src/intents/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const KEY = `sk-ant-api03-${'a'.repeat(40)}`;

describe('auth.read', { timeout: TIMEOUT }, () => {
  let t: TestApi;

  const writeSetting = async (content: string) => {
    await mkdir(join(t.homeDir, '.quarterdeck'), { recursive: true });
    await writeFile(join(t.homeDir, '.quarterdeck', 'claude.json'), content);
  };

  beforeAll(async () => {
    t = await startTestApi();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => t.close());

  it('reads the default mode without recording anything', async () => {
    vi.stubEnv('QUARTERDECK_CLAUDE_AUTH', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    const res = await t.send('auth.read', {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent: 'auth.read',
      status: 'applied',
      id: null,
    });
    expect(authReadResultSchema.parse(res.body.result)).toEqual({
      claude: {
        mode: 'subscription',
        source: 'default',
        missing: [],
        keySource: null,
        gateway: false,
      },
    });
  });

  it('shows the api_key mode from the machine file and where the key comes from, never the key', async () => {
    vi.stubEnv('QUARTERDECK_CLAUDE_AUTH', '');
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example.com');
    await writeSetting(JSON.stringify({ auth: 'api_key' }));
    const res = await t.send('auth.read', {});
    expect(res.status).toBe(200);
    expect(authReadResultSchema.parse(res.body.result).claude).toEqual({
      mode: 'api_key',
      source: 'file',
      missing: [],
      keySource: 'env',
      gateway: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-');
  });

  it('names what vertex is missing', async () => {
    vi.stubEnv('QUARTERDECK_CLAUDE_AUTH', 'vertex');
    vi.stubEnv('ANTHROPIC_VERTEX_PROJECT_ID', 'example-project');
    vi.stubEnv('CLOUD_ML_REGION', '');
    const res = await t.send('auth.read', {});
    expect(authReadResultSchema.parse(res.body.result).claude).toMatchObject({
      mode: 'vertex',
      source: 'env',
      missing: ['CLOUD_ML_REGION'],
    });
  });

  it('answers 409 for a mode it does not know', async () => {
    vi.stubEnv('QUARTERDECK_CLAUDE_AUTH', 'max');
    const res = await t.send('auth.read', {});
    expect(res.status).toBe(409);
    expect(res.body['error']).toContain('QUARTERDECK_CLAUDE_AUTH is "max"');
  });
});
