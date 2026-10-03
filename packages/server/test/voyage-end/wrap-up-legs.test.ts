import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TurnFormat, TurnOutcome } from '../../src/driver/index.js';
import {
  WRAP_UP_EVENTS,
  wrapUpVoyage,
  type WrapUpLeg,
  type WrapUpOptions,
} from '../../src/voyage-end/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  eventPayloads,
  insertAgent,
  insertVoyage,
} from './fixtures.js';

interface ProposalRow {
  op: string;
  body: string | null;
  entryId: string | null;
  global: boolean;
}

const proposalsOf = async (store: Store): Promise<ProposalRow[]> => {
  const { rows } = await store.db.query<ProposalRow>(
    `select op, body, entry_id as "entryId", global from notebook_proposals
     where project_id = $1 order by op, body`,
    [store.projectId],
  );
  return rows;
};

const addEntry = async (
  store: Store,
  body: string,
  global: boolean,
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(
    `insert into notebook (project_id, body)
     values (case when $3 then null else $1::uuid end, $2) returning id`,
    [store.projectId, body, global],
  );
  return rows[0]?.id ?? '';
};

const replying =
  (reply: unknown) =>
  async <T>(_input: string, format: TurnFormat<T>): Promise<TurnOutcome<T>> => {
    const parsed = format.schema.safeParse(reply);
    if (!parsed.success)
      return { status: 'missed', error: parsed.error.message, turns: [] };
    return { status: 'result', result: parsed.data, turns: [] };
  };

describe('wrap-up across a voyage’s projects', { timeout: TIMEOUT }, () => {
  let example: Store;
  let sample: Store;
  let legs: WrapUpLeg[];

  beforeAll(async () => {
    example = await openStore({ project: 'example', dataDir: IN_MEMORY });
    sample = await openStore({ project: 'sample', dataDir: IN_MEMORY });
    legs = [];
    for (const [project, store] of [
      ['example', example],
      ['sample', sample],
    ] as const) {
      const voyageId = await insertVoyage(store, 5);
      const agentId = await insertAgent(store, {
        name: 'lark',
        role: 'driver',
        voyageId,
      });
      legs.push({ project, store, voyageId, agentId });
    }
  }, TIMEOUT);

  afterAll(async () => {
    await example.close();
    await sample.close();
  });

  const options = (reply: unknown): WrapUpOptions => {
    const [lead] = legs;
    return {
      store: example,
      charter: '# Driver charter',
      legs,
      voyage: {
        agent: {
          id: lead?.agentId ?? '',
          projectId: example.projectId,
          voyageId: lead?.voyageId ?? null,
          name: 'lark',
          role: 'driver',
          runtime: 'kiro',
          status: 'idle',
          sessionId: null,
          worktreePath: null,
        },
        voyage: {
          id: lead?.voyageId ?? '',
          number: 5,
          status: 'active',
          goal: '',
        },
        turnAs: replying(reply),
      },
    };
  };

  it('files each proposal with the project it is about, and global ones with the lead', async () => {
    const shared = await addEntry(
      example,
      'Every repo ships with tests.',
      true,
    );
    const local = await addEntry(sample, 'Sample uses pnpm.', false);

    const wrapUp = await wrapUpVoyage(
      options({
        summary: 'Shipped both.',
        notebook: [
          { op: 'add', body: 'Sample deploys on merge.', project: 'sample' },
          { op: 'add', body: 'Run both test suites.' },
          { op: 'update', entry: local, body: 'Sample uses npm now.' },
          { op: 'retire', entry: shared },
        ],
        charter: { body: '# Driver charter\n\nBe terse.' },
      }),
    );

    expect(wrapUp).toEqual(
      expect.objectContaining({ status: 'proposed', summary: 'Shipped both.' }),
    );
    expect(await proposalsOf(example)).toEqual([
      { op: 'add', body: 'Run both test suites.', entryId: null, global: true },
      { op: 'retire', body: null, entryId: shared, global: false },
    ]);
    expect(await proposalsOf(sample)).toEqual([
      {
        op: 'add',
        body: 'Sample deploys on merge.',
        entryId: null,
        global: false,
      },
      {
        op: 'update',
        body: 'Sample uses npm now.',
        entryId: local,
        global: false,
      },
    ]);
    const [exampleEvent] = await eventPayloads(
      example,
      WRAP_UP_EVENTS.proposed,
    );
    const [sampleEvent] = await eventPayloads(sample, WRAP_UP_EVENTS.proposed);
    expect(exampleEvent?.['charterProposal']).toEqual(expect.any(String));
    expect(sampleEvent?.['charterProposal']).toBeNull();
    expect(sampleEvent?.['voyageId']).toBe(legs[1]?.voyageId);
  });

  it('misses a wrap-up that names a project outside the voyage', async () => {
    const wrapUp = await wrapUpVoyage(
      options({
        summary: 'Done.',
        notebook: [{ op: 'add', body: 'x', project: 'elsewhere' }],
      }),
    );

    expect(wrapUp.status).toBe('missed');
    expect(await eventPayloads(sample, WRAP_UP_EVENTS.missed)).toHaveLength(1);
  });
});
