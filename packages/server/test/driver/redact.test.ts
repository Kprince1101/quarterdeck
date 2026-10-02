import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  DRIVER_TURN_FORMAT,
  REDACTED,
  TURN_EVENTS,
  redactSecrets,
  runTurn,
  turnDir,
  turnFile,
} from '../../src/driver/index.js';
import { mergeTextChunks } from '../../src/driver/files.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from './scripted-agent.js';

const TIMEOUT = 30_000;

const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5f6'.repeat(3)}`;
const DB_PASSWORD = 'hunter2-example-pass';
const POSTGRES_URL = `postgres://builder:${DB_PASSWORD}@db.example:5432/example`;
const FOO_TOKEN = 'example-foo-token-value-9f8e7d';

describe('redactSecrets', () => {
  const cases: [string, string, string][] = [
    ['GitHub classic', `token ${GITHUB_TOKEN} end`, `token ${REDACTED} end`],
    [
      'GitHub OAuth',
      `gho_${'x'.repeat(36)} and ghs_${'y'.repeat(36)}`,
      `${REDACTED} and ${REDACTED}`,
    ],
    ['GitHub fine-grained', `github_pat_${'Ab1_'.repeat(20)}`, REDACTED],
    ['Anthropic', `key=sk-ant-api03-${'z'.repeat(40)}`, `key=${REDACTED}`],
    ['OpenAI', `sk-proj-${'q'.repeat(40)}`, REDACTED],
    ['AWS', `AKIA${'ABCDEFGHIJKLMNOP'}`, REDACTED],
    [
      'Bearer',
      'Authorization: Bearer abc.def-ghi_jkl',
      `Authorization: Bearer ${REDACTED}`,
    ],
    [
      'Postgres URL',
      `DATABASE=${POSTGRES_URL}`,
      `DATABASE=postgres://builder:${REDACTED}@db.example:5432/example`,
    ],
    [
      'PEM private key',
      `before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef==\n-----END RSA PRIVATE KEY-----\nafter`,
      `before\n${REDACTED}\nafter`,
    ],
  ];

  it.each(cases)('redacts a %s secret', (_name, input, expected) => {
    expect(redactSecrets(input, {})).toBe(expected);
  });

  it('redacts the values of secret-looking env vars and nothing else', () => {
    const env = {
      FOO_TOKEN,
      API_SECRET: 'example-secret-value',
      SIGNING_KEY: 'example-signing-key',
      DB_PASSWORD: 'example-db-password',
      DATABASE_URL: 'pglite-local-example',
      HOME: '/home/builder-1',
      SHORT_TOKEN: 'abc',
    };
    const text = Object.values(env).join(' | ');
    expect(redactSecrets(text, env)).toBe(
      [
        REDACTED,
        REDACTED,
        REDACTED,
        REDACTED,
        REDACTED,
        '/home/builder-1',
        'abc',
      ].join(' | '),
    );
  });

  it('treats KEY as a secret name only as a whole word at either end', () => {
    const env = {
      API_KEY: 'example-api-key-value',
      KEY_ID: 'example-key-id-value',
      SSH_KEY_PATH: '/home/builder-1/.ssh/id_ed25519',
      KEYCHAIN_DIR: '/home/builder-1/keychains',
      MONKEY_BUSINESS: 'example-monkey-value',
    };
    const text = Object.values(env).join(' | ');
    expect(redactSecrets(text, env)).toBe(
      [
        REDACTED,
        REDACTED,
        '/home/builder-1/.ssh/id_ed25519',
        '/home/builder-1/keychains',
        'example-monkey-value',
      ].join(' | '),
    );
  });

  it('leaves ordinary text alone', () => {
    const text =
      'Opened https://github.com/example/example/pull/12 for task-42.';
    expect(redactSecrets(text, {})).toBe(text);
  });
});

describe('turn transcripts', () => {
  let store: Store;
  let scripted: ScriptedAgent;
  let turnsDir: string;
  let agentId: string;

  beforeAll(async () => {
    store = await openStore({ project: 'example', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    vi.stubEnv('FOO_TOKEN', FOO_TOKEN);
    scripted = await startScriptedAgent();
    turnsDir = await mkdtemp(join(tmpdir(), 'qd-redact-'));
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, 'builder-1', 'driver', 'idle') returning id`,
      [store.projectId],
    );
    agentId = rows[0]?.id ?? '';
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await scripted.client.close();
    await rm(turnsDir, { recursive: true, force: true });
    await store.db.exec(
      'delete from events; delete from turns; delete from agents;',
    );
  });

  const secrets = [GITHUB_TOKEN, DB_PASSWORD, FOO_TOKEN];

  const expectRedacted = (text: string) => {
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain(REDACTED);
  };

  it(
    'stores turn input, output, updates, result, row and events with secrets redacted',
    async () => {
      const leak = `pushed with ${GITHUB_TOKEN}, db ${POSTGRES_URL}, foo ${FOO_TOKEN}`;
      const result = { summary: leak, actions: [] };
      scripted.reply(say(`${leak}\n\n${resultText(result)}`));
      const { sessionId } = await scripted.client.newSession({
        cwd: turnsDir,
        mcpServers: [],
      });

      const outcome = await runTurn(
        {
          store,
          client: scripted.client,
          agent: { id: agentId, runtime: 'claude' },
          sessionId,
          turnsDir,
        },
        `Use ${FOO_TOKEN} to reach ${POSTGRES_URL}.`,
        DRIVER_TURN_FORMAT,
      );

      expect(scripted.prompts[0]?.text).toContain(FOO_TOKEN);
      expect(outcome.status).toBe('result');

      const dir = turnDir(turnsDir, agentId, 1);
      const output = await readFile(turnFile(dir, 'output'), 'utf8');
      expectRedacted(output);
      expect(output).toContain(
        `pushed with ${REDACTED}, db postgres://builder:${REDACTED}@db.example:5432/example, foo ${REDACTED}`,
      );
      expectRedacted(await readFile(turnFile(dir, 'updates'), 'utf8'));
      expectRedacted(await readFile(turnFile(dir, 'result'), 'utf8'));
      expectRedacted(await readFile(turnFile(dir, 'input'), 'utf8'));

      const { rows } = await store.db.query<{ prompt: string }>(
        'select prompt from turns where agent_id = $1',
        [agentId],
      );
      expectRedacted(rows[0]?.prompt ?? '');

      const events = await store.db.query<{ payload: unknown }>(
        'select payload from events where kind = $1',
        [TURN_EVENTS.result],
      );
      expectRedacted(JSON.stringify(events.rows[0]?.payload));

      if (process.platform !== 'win32') {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(turnsDir, agentId))).mode & 0o777).toBe(0o700);
        for (const file of ['input', 'output', 'updates', 'result'] as const) {
          expect((await stat(turnFile(dir, file))).mode & 0o777).toBe(0o600);
        }
      }
    },
    TIMEOUT,
  );

  it(
    'redacts secrets split across streamed chunks in updates.jsonl',
    async () => {
      const result = { summary: 'Done.', actions: [] };
      scripted.reply({
        chunks: [
          `here: ${GITHUB_TOKEN.slice(0, 10)}`,
          `${GITHUB_TOKEN.slice(10)} and ${FOO_TOKEN.slice(0, 12)}`,
          `${FOO_TOKEN.slice(12)} done\n\n${resultText(result)}`,
        ],
      });
      const { sessionId } = await scripted.client.newSession({
        cwd: turnsDir,
        mcpServers: [],
      });

      await runTurn(
        {
          store,
          client: scripted.client,
          agent: { id: agentId, runtime: 'claude' },
          sessionId,
          turnsDir,
        },
        'Report back.',
        DRIVER_TURN_FORMAT,
      );

      const dir = turnDir(turnsDir, agentId, 1);
      const updates = await readFile(turnFile(dir, 'updates'), 'utf8');
      expect(updates).not.toContain(GITHUB_TOKEN);
      expect(updates).not.toContain(FOO_TOKEN);
      expect(updates).toContain(`here: ${REDACTED} and ${REDACTED} done`);
      expect(await readFile(turnFile(dir, 'output'), 'utf8')).toContain(
        `here: ${REDACTED} and ${REDACTED} done`,
      );
    },
    TIMEOUT,
  );
});

describe('mergeTextChunks', () => {
  const chunk = (
    sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string,
  ): SessionUpdate => ({ sessionUpdate, content: { type: 'text', text } });

  it('joins each run of message or thought chunks and keeps other updates', () => {
    const plan: SessionUpdate = { sessionUpdate: 'plan', entries: [] };
    expect(
      mergeTextChunks([
        chunk('agent_thought_chunk', 'think '),
        chunk('agent_thought_chunk', 'more'),
        chunk('agent_message_chunk', 'say '),
        chunk('agent_message_chunk', 'this'),
        plan,
        chunk('agent_message_chunk', 'after'),
      ]),
    ).toEqual([
      chunk('agent_thought_chunk', 'think more'),
      chunk('agent_message_chunk', 'say this'),
      plan,
      chunk('agent_message_chunk', 'after'),
    ]);
  });
});
