import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_TURN_INSTRUCTIONS,
  buildBirthInput,
  turnDir,
  turnFile,
} from '../../src/driver/index.js';
import { turnReadResultSchema } from '../../src/intents/index.js';
import { projectTurnsDir, type Store } from '../../src/store/index.js';
import { TIMEOUT, startTestApi, type TestApi } from './harness.js';

const project = 'turns';

const birthInput = (name: string, round: number): string =>
  buildBirthInput({
    agent: { name },
    round: { number: round, goal: `Goal ${round}.` },
    charter: '# Driver charter',
    notebook: [],
    instructions: DRIVER_TURN_INSTRUCTIONS,
  });

interface SavedTurn {
  seq: number;
  input: string;
  output?: string;
  result?: unknown;
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
    const { rows } = await store.db.query<{ id: number }>(
      `insert into turns (agent_id, seq, prompt, transcript_path)
       values ($1, $2, $3, $4) returning id`,
      [agentId, turn.seq, turn.input, dir],
    );
    return Number(rows[0]?.id);
  };

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
    const newt = await insertAgent('newt', 'driver');
    const heron = await insertAgent('heron', 'driver');
    const otter = await insertAgent('otter', 'builder');
    const result = { summary: 'assigned QD1', actions: [] };
    turns.birth = await save(newt, {
      seq: 1,
      input: birthInput('newt', 1),
      output: 'born',
      bornAt: new Date('2026-01-01'),
    });
    turns.second = await save(newt, {
      seq: 2,
      input: 'gull reported QD1.',
      output: '```json\n{}\n```',
      result,
    });
    turns.reborn = await save(newt, {
      seq: 3,
      input: birthInput('newt', 2),
      bornAt: new Date('2026-01-02'),
    });
    turns.earlier = await save(newt, { seq: 4, input: 'still round 2' });
    turns.later = await save(heron, {
      seq: 1,
      input: birthInput('heron', 2),
      bornAt: new Date('2026-01-03'),
    });
    turns.builder = await save(otter, { seq: 1, input: 'build QD1' });
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

  it('places a Driver turn in its round, counting from the birth', async () => {
    expect(await read(turns.birth ?? 0)).toMatchObject({
      round: 1,
      n: 1,
      latestSession: true,
    });
    expect(await read(turns.second ?? 0)).toMatchObject({
      round: 1,
      n: 2,
      latestSession: true,
    });
  });

  it('says when a later Driver session took the round over', async () => {
    expect(await read(turns.earlier ?? 0)).toMatchObject({
      round: 2,
      n: 2,
      latestSession: false,
    });
    expect(await read(turns.later ?? 0)).toMatchObject({
      round: 2,
      n: 1,
      latestSession: true,
    });
  });

  it('gives no round for a turn outside a Driver session', async () => {
    expect(await read(turns.builder ?? 0)).toMatchObject({
      input: 'build QD1',
      round: null,
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
