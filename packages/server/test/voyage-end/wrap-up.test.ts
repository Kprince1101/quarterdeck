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
import { openDriverVoyage, type DriverVoyage } from '../../src/driver/index.js';
import {
  MAX_NOTEBOOK_PROPOSALS,
  WRAP_UP_EVENTS,
  buildWrapUpPrompt,
  wrapUpVoyage,
  wrapUpResultSchema,
} from '../../src/voyage-end/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from '../driver/scripted-agent.js';
import {
  CLEAR_VOYAGE_TABLES,
  TIMEOUT,
  eventPayloads,
  insertAgent,
  insertVoyage,
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
  voyageId: string | null;
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
    await store.db.exec(CLEAR_VOYAGE_TABLES);
  });

  const addNote = async (body: string, pinned = false): Promise<string> => {
    const { rows } = await store.db.query<{ id: string }>(
      `insert into notebook (project_id, body, pinned)
       values ($1, $2, $3) returning id`,
      [store.projectId, body, pinned],
    );
    return rows[0]?.id ?? '';
  };

  const openVoyage = async (): Promise<DriverVoyage> => {
    const voyageId = await insertVoyage(store, 3);
    const agentId = await insertAgent(store, {
      name: 'lark',
      role: 'driver',
      voyageId,
    });
    scripted.reply(say(resultText(BIRTH)));
    const voyage = await openDriverVoyage({
      store,
      client: scripted.client,
      bus: { launch: async () => BUS },
      agentId,
      voyageId,
      cwd: '/work/deck',
      charter: CHARTER,
      turnsDir,
      budget: { hours: 5, capTokens: null, holdAtFraction: 0.8 },
      pause: { hold: (_subject, run) => run() },
    });
    await voyage.birth;
    return voyage;
  };

  const notebookProposals = async (): Promise<ProposalRow[]> => {
    const { rows } = await store.db.query<ProposalRow>(
      `select op, entry_id as "entryId", body, pinned, rationale, status,
              voyage_id as "voyageId", agent_id as "agentId"
       from notebook_proposals order by created_at, op`,
    );
    return rows;
  };

  const charterProposals = async () => {
    const { rows } = await store.db.query<{
      body: string;
      rationale: string;
      voyageId: string | null;
      agentId: string | null;
    }>(
      `select body, rationale, voyage_id as "voyageId", agent_id as "agentId"
       from charter_proposals`,
    );
    return rows;
  };

  it('asks the Driver for proposals in its voyage session, listing entries by id', async () => {
    const kept = await addNote('Reviews go to reviewer-1.');
    const pinned = await addNote('PRs need tests.', true);
    const voyage = await openVoyage();
    scripted.reply(
      say(
        resultText({
          summary: 'Shipped QD5f.',
          notebook: [],
          charter: null,
        }),
      ),
    );

    const wrapUp = await wrapUpVoyage({ store, voyage, charter: CHARTER });

    expect(wrapUp).toEqual({
      status: 'proposed',
      summary: 'Shipped QD5f.',
      notebookProposalIds: [],
      charterProposalId: null,
    });
    const prompt = scripted.prompts[1];
    expect(prompt?.sessionId).toBe(voyage.sessionId);
    expect(prompt?.text).toBe(
      buildWrapUpPrompt({
        voyage: voyage.voyage,
        charter: CHARTER,
        notebook: voyage.notebook,
      }),
    );
    expect(prompt?.text).toContain(`### ${pinned} (pinned)\n\nPRs need tests.`);
    expect(prompt?.text).toContain(`### ${kept}\n\nReviews go to reviewer-1.`);
    expect(prompt?.text).toContain('Voyage 3 has settled');
    expect(prompt?.text).toContain(CHARTER);
  });

  it('saves notebook and charter proposals with an event, all open', async () => {
    const stale = await addNote('Deploy on Fridays.');
    const vague = await addNote('Tests matter.');
    const voyage = await openVoyage();
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

    const wrapUp = await wrapUpVoyage({ store, voyage, charter: CHARTER });

    const source = { voyageId: voyage.voyage.id, agentId: voyage.agent.id };
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
        voyageId: voyage.voyage.id,
        voyage: 3,
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
    const voyage = await openVoyage();
    scripted.reply(
      say(
        resultText({
          summary: 'Quiet voyage.',
          notebook: [{ op: 'update', entry, body: 'Tests matter.' }],
          charter: { body: CHARTER },
        }),
      ),
    );

    expect(await wrapUpVoyage({ store, voyage, charter: CHARTER })).toEqual({
      status: 'proposed',
      summary: 'Quiet voyage.',
      notebookProposalIds: [],
      charterProposalId: null,
    });
    expect(await charterProposals()).toEqual([]);
  });

  it('re-prompts once for an entry id that is not in the notebook, then records a miss', async () => {
    await addNote('Tests matter.');
    const voyage = await openVoyage();
    const unknown = {
      summary: 'Done.',
      notebook: [{ op: 'retire', entry: crypto.randomUUID() }],
      charter: null,
    };
    scripted.reply(say(resultText(unknown)), say(resultText(unknown)));

    const wrapUp = await wrapUpVoyage({ store, voyage, charter: CHARTER });

    expect(wrapUp.status).toBe('missed');
    expect(scripted.prompts).toHaveLength(3);
    expect(scripted.prompts[2]?.text).toContain(
      'entry must be the id of an active notebook entry',
    );
    expect(await notebookProposals()).toEqual([]);
    const [missed] = await eventPayloads(store, WRAP_UP_EVENTS.missed);
    expect(missed).toMatchObject({ voyageId: voyage.voyage.id, voyage: 3 });
    expect(String(missed?.['reason'])).toContain('active notebook entry');
  });

  it('records a miss when the wrap-up turn stops or fails', async () => {
    const voyage = await openVoyage();
    scripted.reply(say('No.', { stopReason: 'refusal' }));

    expect(await wrapUpVoyage({ store, voyage, charter: CHARTER })).toEqual({
      status: 'missed',
      reason: 'the wrap-up turn stopped: refusal',
    });

    scripted.reply({ fail: 'agent died' });

    const failed = await wrapUpVoyage({ store, voyage, charter: CHARTER });

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
