import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_TURN_INSTRUCTIONS,
  VOYAGE_STARTED_EVENT,
  buildBirthInput,
  turnDir,
  turnFile,
} from '../../src/driver/index.js';
import { turnReadResultSchema } from '../../src/intents/index.js';
import { projectTurnsDir, type Store } from '../../src/store/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const project = 'turns';

const birthInput = (name: string, voyage: number): string =>
  buildBirthInput({
    agent: { name },
    voyage: { number: voyage, goal: `Goal ${voyage}.` },
    charter: '# Driver charter',
    notebook: [],
    instructions: DRIVER_TURN_INSTRUCTIONS,
  });

interface SavedTurn {
  seq: number;
  input: string;
  output?: string;
  result?: unknown;
  rawResult?: string;
  bornAt?: Date;
}

describe('turn.read', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let store: Store;
  let turnsDir: string;

  const insertAgent = async (name: string, role: string) => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into agents (project_id, name, role, status)
       values ($1, $2, $3, 'idle') returning id`,
      [store.projectId, name, role],
    );
    const [row] = rows;
    if (!row) throw new Error('no agent row');
    return row.id;
  };

  const save = async (agentId: string, turn: SavedTurn): Promise<number> => {
    const dir = turnDir(turnsDir, agentId, turn.seq);
    await mkdir(dir, { recursive: true });
    await writeFile(turnFile(dir, 'input'), turn.input);
    if (turn.bornAt) {
      await utimes(turnFile(dir, 'input'), turn.bornAt, turn.bornAt);
    }
    if (turn.output !== undefined) {
      await writeFile(turnFile(dir, 'output'), turn.output);
    }
    if (turn.result !== undefined) {
      await writeFile(turnFile(dir, 'result'), JSON.stringify(turn.result));
    }
    if (turn.rawResult !== undefined) {
      await writeFile(turnFile(dir, 'result'), turn.rawResult);
    }
    const { rows } = await store.db.query<{ id: number }>(
      `insert into turns (agent_id, seq, prompt, transcript_path)
       values ($1, $2, $3, $4) returning id`,
      [agentId, turn.seq, turn.input, dir],
    );
    return Number(rows[0]?.id);
  };

  const voyageStarted = (agentId: string, voyage: number) =>
    store.publish({
      kind: VOYAGE_STARTED_EVENT,
      agentId,
      payload: { voyageId: crypto.randomUUID(), voyage },
    });

  const read = async (turnId: number) => {
    const res = await t.send('turn.read', { project, turnId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent: 'turn.read',
      status: 'applied',
      id: null,
    });
    return turnReadResultSchema.parse(res.body.result);
  };

  const turns: Record<string, number> = {};

  beforeAll(async () => {
    t = await startTestApi();
    await t.send('project.create', { project });
    store = await t.store(project);
    turnsDir = projectTurnsDir(project, join(t.homeDir, '.quarterdeck'));
    const driver1 = await insertAgent('driver-1', 'driver');
    const heron = await insertAgent('heron', 'driver');
    const otter = await insertAgent('otter', 'builder');
    const stray = await insertAgent('stray', 'driver');
    await voyageStarted(driver1, 1);
    await voyageStarted(driver1, 2);
    await voyageStarted(heron, 2);
    const result = { summary: 'assigned QD1', actions: [] };
    turns.birth = await save(driver1, {
      seq: 1,
      input: birthInput('driver-1', 1),
      output: 'born',
      bornAt: new Date('2026-01-01'),
    });
    turns.second = await save(driver1, {
      seq: 2,
      input: 'gull reported QD1.',
      output: '```json\n{}\n```',
      result,
    });
    turns.reborn = await save(driver1, {
      seq: 3,
      input: birthInput('driver-1', 2),
      bornAt: new Date('2026-01-02'),
    });
    turns.earlier = await save(driver1, { seq: 4, input: 'still voyage 2' });
    turns.later = await save(heron, {
      seq: 1,
      input: birthInput('heron', 2),
      bornAt: new Date('2026-01-03'),
    });
    turns.builder = await save(otter, { seq: 1, input: 'build QD1' });
    turns.malformed = await save(otter, {
      seq: 2,
      input: 'build QD2',
      output: 'half a reply',
      rawResult: '{"summary": ',
    });
    await save(stray, {
      seq: 1,
      input: birthInput('stray', 2),
      bornAt: new Date('2026-01-04'),
    });
  }, TIMEOUT);

  afterAll(async () => {
    await t.close();
  });

  it('returns the prompt, output and result of a turn', async () => {
    expect(await read(turns.second ?? 0)).toMatchObject({
      turnId: turns.second,
      seq: 2,
      input: 'gull reported QD1.',
      output: '```json\n{}\n```',
      result: { summary: 'assigned QD1', actions: [] },
    });
  });

  it('gives null for an output or result not written yet', async () => {
    expect(await read(turns.earlier ?? 0)).toMatchObject({
      output: null,
      result: null,
    });
  });

  it('places a Driver turn in its voyage, counting from the birth', async () => {
    expect(await read(turns.birth ?? 0)).toMatchObject({
      voyage: 1,
      n: 1,
      latestSession: true,
    });
    expect(await read(turns.second ?? 0)).toMatchObject({
      voyage: 1,
      n: 2,
      latestSession: true,
    });
  });

  it('says when a later Driver session took the voyage over', async () => {
    expect(await read(turns.earlier ?? 0)).toMatchObject({
      voyage: 2,
      n: 2,
      latestSession: false,
    });
    expect(await read(turns.later ?? 0)).toMatchObject({
      voyage: 2,
      n: 1,
      latestSession: true,
    });
  });

  it('weighs only the sessions of agents that started the voyage', async () => {
    expect(await read(turns.later ?? 0)).toMatchObject({
      voyage: 2,
      latestSession: true,
    });
  });

  it('gives a null result for a result.json it cannot parse', async () => {
    expect(await read(turns.malformed ?? 0)).toMatchObject({
      input: 'build QD2',
      output: 'half a reply',
      result: null,
    });
  });

  it('gives no voyage for a turn outside a Driver session', async () => {
    expect(await read(turns.builder ?? 0)).toMatchObject({
      input: 'build QD1',
      voyage: null,
      n: null,
      latestSession: false,
    });
  });

  it('records nothing', async () => {
    const { rows } = await store.db.query<{ intents: number; events: number }>(
      `select
         (select count(*)::int from intents where kind = 'turn.read') as intents,
         (select count(*)::int from events where kind = 'turn.read') as events`,
    );
    expect(rows[0]).toEqual({ intents: 0, events: 0 });
  });

  it('refuses a turn the project does not have', async () => {
    await t.send('project.create', { project: 'other' });
    const missing = await t.send('turn.read', { project, turnId: 999_999 });
    expect(missing.status).toBe(404);
    const elsewhere = await t.send('turn.read', {
      project: 'other',
      turnId: turns.second,
    });
    expect(elsewhere.status).toBe(404);
    const invalid = await t.send('turn.read', { project, turnId: 'one' });
    expect(invalid.status).toBe(400);
  });
});
