import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { openDriverRound, type DriverRound } from '../../src/driver/index.js';
import {
  MAX_NOTEBOOK_PROPOSALS,
  WRAP_UP_EVENTS,
  buildWrapUpPrompt,
  wrapUpRound,
  wrapUpResultSchema,
} from '../../src/round-end/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from '../driver/scripted-agent.js';
import {
  CLEAR_ROUND_TABLES,
  TIMEOUT,
  eventPayloads,
  insertAgent,
  insertRound,
} from './fixtures.js';

const CHARTER = '# Driver charter\n\nTurn tickets into merged pull requests.';
const BIRTH = { summary: 'Nothing to assign.', actions: [] };
const BUS: McpServerStdio = {
  name: 'quarterdeck',
  command: 'node',
  args: ['relay.js'],
  env: [],
};

interface ProposalRow {
  op: string;
  entryId: string | null;
  body: string | null;
  pinned: boolean;
  rationale: string;
  status: string;
  roundId: string | null;
  agentId: string | null;
}

describe('wrap-up', { timeout: TIMEOUT }, () => {
  let store: Store;
  let scripted: ScriptedAgent;
  let turnsDir: string;

  beforeAll(async () => {
    store = await openStore({ project: 'deck', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    scripted = await startScriptedAgent();
    turnsDir = await mkdtemp(join(tmpdir(), 'qd-wrap-up-'));
  });

  afterEach(async () => {
    await scripted.client.close();
    await rm(turnsDir, { recursive: true, force: true });
    await store.db.exec(CLEAR_ROUND_TABLES);
  });

  const addNote = async (body: string, pinned = false): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into notebook (project_id, body, pinned)
       values ($1, $2, $3) returning id`,
      [store.projectId, body, pinned],
    );
    return rows[0]?.id ?? '';
  };

  const openRound = async (): Promise<DriverRound> => {
    const roundId = await insertRound(store, 3);
    const agentId = await insertAgent(store, {
      name: 'lark',
      role: 'driver',
      roundId,
    });
    scripted.reply(say(resultText(BIRTH)));
    const round = await openDriverRound({
      store,
      client: scripted.client,
      bus: { launch: async () => BUS },
      agentId,
      roundId,
      cwd: '/work/deck',
      charter: CHARTER,
      turnsDir,
    });
    await round.birth;
    return round;
  };

  const notebookProposals = async (): Promise<ProposalRow[]> => {
    const { rows } = await store.db.query<ProposalRow>(
      `select op, entry_id as "entryId", body, pinned, rationale, status,
              round_id as "roundId", agent_id as "agentId"
       from notebook_proposals order by created_at, op`,
    );
    return rows;
  };

  const charterProposals = async () => {
    const { rows } = await store.db.query<{
      body: string;
      rationale: string;
      roundId: string | null;
      agentId: string | null;
    }>(
      `select body, rationale, round_id as "roundId", agent_id as "agentId"
       from charter_proposals`,
    );
    return rows;
  };

  it('asks the Driver for proposals in its round session, listing entries by id', async () => {
    const kept = await addNote('Reviews go to thimble.');
    const pinned = await addNote('PRs need tests.', true);
    const round = await openRound();
    scripted.reply(
      say(
        resultText({
          summary: 'Shipped QD5f.',
          notebook: [],
          charter: null,
        }),
      ),
    );

    const wrapUp = await wrapUpRound({ store, round, charter: CHARTER });

    expect(wrapUp).toEqual({
      status: 'proposed',
      summary: 'Shipped QD5f.',
      notebookProposalIds: [],
      charterProposalId: null,
    });
    const prompt = scripted.prompts[1];
    expect(prompt?.sessionId).toBe(round.sessionId);
    expect(prompt?.text).toBe(
      buildWrapUpPrompt({
        round: round.round,
        charter: CHARTER,
        notebook: round.notebook,
      }),
    );
    expect(prompt?.text).toContain(`### ${pinned} (pinned)\n\nPRs need tests.`);
    expect(prompt?.text).toContain(`### ${kept}\n\nReviews go to thimble.`);
    expect(prompt?.text).toContain('Round 3 has settled');
    expect(prompt?.text).toContain(CHARTER);
  });

  it('saves notebook and charter proposals with an event, all open', async () => {
    const stale = await addNote('Deploy on Fridays.');
    const vague = await addNote('Tests matter.');
    const round = await openRound();
    scripted.reply(
      say(
        resultText({
          summary: 'Shipped QD5f; QD5g is next.',
          notebook: [
            {
              op: 'add',
              body: 'Run store tests on both backends.',
              pinned: true,
              rationale: 'QD13 broke Postgres only.',
            },
            {
              op: 'update',
              entry: vague,
              body: 'Every ticket ships with tests.',
              rationale: 'Sharper.',
            },
            { op: 'retire', entry: stale, rationale: 'No longer true.' },
          ],
          charter: {
            body: '# Driver charter\n\nBe terse.',
            rationale: 'Less noise.',
          },
        }),
      ),
    );

    const wrapUp = await wrapUpRound({ store, round, charter: CHARTER });

    const source = { roundId: round.round.id, agentId: round.agent.id };
    expect(await notebookProposals()).toEqual([
      {
        op: 'add',
        entryId: null,
        body: 'Run store tests on both backends.',
        pinned: true,
        rationale: 'QD13 broke Postgres only.',
        status: 'open',
        ...source,
      },
      {
        op: 'retire',
        entryId: stale,
        body: null,
        pinned: false,
        rationale: 'No longer true.',
        status: 'open',
        ...source,
      },
      {
        op: 'update',
        entryId: vague,
        body: 'Every ticket ships with tests.',
        pinned: false,
        rationale: 'Sharper.',
        status: 'open',
        ...source,
      },
    ]);
    expect(await charterProposals()).toEqual([
      {
        body: '# Driver charter\n\nBe terse.',
        rationale: 'Less noise.',
        ...source,
      },
    ]);
    if (wrapUp.status !== 'proposed') throw new Error('expected proposals');
    expect(wrapUp.notebookProposalIds).toHaveLength(3);
    expect(await eventPayloads(store, WRAP_UP_EVENTS.proposed)).toEqual([
      {
        roundId: round.round.id,
        round: 3,
        summary: 'Shipped QD5f; QD5g is next.',
        notebookProposals: wrapUp.notebookProposalIds,
        charterProposal: wrapUp.charterProposalId,
      },
    ]);
    const { rows } = await store.db.query(
      'select body from notebook order by created_at',
    );
    expect(rows).toEqual([
      { body: 'Deploy on Fridays.' },
      { body: 'Tests matter.' },
    ]);
  });

  it('drops an update that changes nothing and a charter that matches the current one', async () => {
    const entry = await addNote('Tests matter.');
    const round = await openRound();
    scripted.reply(
      say(
        resultText({
          summary: 'Quiet round.',
          notebook: [{ op: 'update', entry, body: 'Tests matter.' }],
          charter: { body: CHARTER },
        }),
      ),
    );

    expect(await wrapUpRound({ store, round, charter: CHARTER })).toEqual({
      status: 'proposed',
      summary: 'Quiet round.',
      notebookProposalIds: [],
      charterProposalId: null,
    });
    expect(await charterProposals()).toEqual([]);
  });

  it('re-prompts once for an entry id that is not in the notebook, then records a miss', async () => {
    await addNote('Tests matter.');
    const round = await openRound();
    const unknown = {
      summary: 'Done.',
      notebook: [{ op: 'retire', entry: crypto.randomUUID() }],
      charter: null,
    };
    scripted.reply(say(resultText(unknown)), say(resultText(unknown)));

    const wrapUp = await wrapUpRound({ store, round, charter: CHARTER });

    expect(wrapUp.status).toBe('missed');
    expect(scripted.prompts).toHaveLength(3);
    expect(scripted.prompts[2]?.text).toContain(
      'entry must be the id of an active notebook entry',
    );
    expect(await notebookProposals()).toEqual([]);
    const [missed] = await eventPayloads(store, WRAP_UP_EVENTS.missed);
    expect(missed).toMatchObject({ roundId: round.round.id, round: 3 });
    expect(String(missed?.['reason'])).toContain('active notebook entry');
  });

  it('records a miss when the wrap-up turn stops or fails', async () => {
    const round = await openRound();
    scripted.reply(say('No.', { stopReason: 'refusal' }));

    expect(await wrapUpRound({ store, round, charter: CHARTER })).toEqual({
      status: 'missed',
      reason: 'the wrap-up turn stopped: refusal',
    });

    scripted.reply({ fail: 'agent died' });

    const failed = await wrapUpRound({ store, round, charter: CHARTER });

    expect(failed.status).toBe('missed');
    expect(await eventPayloads(store, WRAP_UP_EVENTS.missed)).toHaveLength(2);
  });

  it('refuses two changes to one entry and too many changes', () => {
    const entry = crypto.randomUUID();
    const schema = wrapUpResultSchema(new Set([entry]));
    const twice = schema.safeParse({
      summary: 'x',
      notebook: [
        { op: 'update', entry, body: 'a' },
        { op: 'retire', entry },
      ],
    });
    expect(twice.success).toBe(false);
    const many = schema.safeParse({
      summary: 'x',
      notebook: Array.from({ length: MAX_NOTEBOOK_PROPOSALS + 1 }, () => ({
        op: 'add',
        body: 'a',
      })),
    });
    expect(many.success).toBe(false);
    expect(
      schema.parse({ summary: 'x', notebook: [{ op: 'add', body: ' a ' }] }),
    ).toEqual({
      summary: 'x',
      notebook: [{ op: 'add', body: 'a', pinned: false, rationale: '' }],
      charter: null,
    });
  });
});
