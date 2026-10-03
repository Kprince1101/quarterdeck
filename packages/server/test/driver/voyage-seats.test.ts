import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { forgeTerms } from '@quarterdeck/rules';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  BUILDER_STUCK_EVENT,
  STUCK_SURFACED_EVENT,
  VOYAGE_STARTED_EVENT,
  openDriverVoyage,
  readBirth,
  type DriverSeat,
  type ProjectBrief,
} from '../../src/driver/index.js';
import { IN_MEMORY, openStore, type Store } from '../../src/store/index.js';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from './scripted-agent.js';

const TIMEOUT = 30_000;
const RESULT = { summary: 'Nothing to assign yet.', actions: [] };
const NO_CAP = { hours: 5, capTokens: null, holdAtFraction: 0.8 };

const one = async (
  store: Store,
  sql: string,
  params: unknown[],
): Promise<string> => {
  const { rows } = await store.db.query<{ id: string }>(sql, params);
  return rows[0]?.id ?? '';
};

const busFor = (launched: string[]) => ({
  launch: async (agentId: string, name = 'bus'): Promise<McpServerStdio> => {
    launched.push(`${name}:${agentId}`);
    return { name, command: 'node', args: ['relay.js'], env: [] };
  },
});

describe('a Driver seated in every project', () => {
  let example: Store;
  let sample: Store;
  let scripted: ScriptedAgent;
  let turnsDir: string;

  beforeAll(async () => {
    example = await openStore({ project: 'example', dataDir: IN_MEMORY });
    sample = await openStore({ project: 'sample', dataDir: IN_MEMORY });
  }, TIMEOUT);

  afterAll(async () => {
    await example.close();
    await sample.close();
  });

  beforeEach(async () => {
    scripted = await startScriptedAgent();
    turnsDir = await mkdtemp(join(tmpdir(), 'qd-seats-'));
  });

  afterEach(async () => {
    await scripted.client.close();
    await rm(turnsDir, { recursive: true, force: true });
  });

  const seat = async (
    store: Store,
    project: string,
    launched: string[],
  ): Promise<DriverSeat> => {
    const voyageId = await one(
      store,
      `insert into voyages (project_id, number, status, goal, projects)
       values ($1, 4, 'active', 'Ship both.', '{example,sample}') returning id`,
      [store.projectId],
    );
    const agentId = await one(
      store,
      `insert into agents (project_id, voyage_id, name, role, status)
       values ($1, $2, 'lark', 'driver', 'idle') returning id`,
      [store.projectId, voyageId],
    );
    return { project, store, bus: busFor(launched), agentId, voyageId };
  };

  it(
    'opens one session with every project’s bus, notes the voyage in each and reads every notebook',
    async () => {
      const launched: string[] = [];
      const lead = await seat(example, 'example', launched);
      const other = await seat(sample, 'sample', launched);
      await one(
        example,
        `insert into notebook (project_id, body) values ($1, 'Example uses pnpm.') returning id`,
        [example.projectId],
      );
      const shared = await one(
        sample,
        `insert into notebook (project_id, body, pinned)
         values (null, 'Every repo ships with tests.', true) returning id`,
        [],
      );
      const builder = await one(
        sample,
        `insert into agents (project_id, name, role, status)
         values ($1, 'wren', 'builder', 'idle') returning id`,
        [sample.projectId],
      );
      await sample.publish({
        kind: BUILDER_STUCK_EVENT,
        agentId: builder,
        payload: { name: 'wren', head: 'abc', continues: 3 },
      });
      const projects: ProjectBrief[] = [
        {
          project: 'example',
          repoPath: '/repos/example',
          bus: 'bus-example',
          terms: forgeTerms('github'),
          waiting: [{ id: 'ticket-1', title: 'Add a greeting' }],
          builders: [],
        },
        {
          project: 'sample',
          repoPath: '/repos/sample',
          bus: 'bus-sample',
          terms: forgeTerms('gitlab'),
          waiting: [],
          builders: [
            { id: builder, name: 'wren', status: 'idle', ticket: null },
          ],
        },
      ];
      scripted.reply(say(resultText(RESULT)));

      const voyage = await openDriverVoyage({
        store: example,
        client: scripted.client,
        bus: lead.bus,
        agentId: lead.agentId,
        voyageId: lead.voyageId,
        cwd: '/home/deck',
        charter: '# Driver charter',
        turnsDir,
        budget: NO_CAP,
        pause: { hold: (_subject, run) => run() },
        seats: [lead, other],
        projects,
      });
      await voyage.birth;

      expect(scripted.sessions[0]?.cwd).toBe('/home/deck');
      expect(scripted.sessions[0]?.mcpServers.map(({ name }) => name)).toEqual([
        'bus-example',
        'bus-sample',
      ]);
      expect(launched).toEqual([
        `bus-example:${lead.agentId}`,
        `bus-sample:${other.agentId}`,
      ]);
      const input = scripted.prompts[0]?.text ?? '';
      expect(readBirth(input)).toEqual({ name: 'lark', voyage: 4 });
      expect(input).toContain('# Projects');
      expect(input).toContain('## example');
      expect(input).toContain(
        'Repository: /repos/example. Bus: `bus-example`. Forge: GitHub (pull requests, PR).',
      );
      expect(input).toContain(
        'Repository: /repos/sample. Bus: `bus-sample`. Forge: GitLab (merge requests, MR).',
      );
      expect(input).toContain('- "Add a greeting" (ticket ticket-1)');
      expect(input).toContain(
        `- wren (builder ${builder}), idle, holding no ticket`,
      );
      expect(input).toContain(
        '### Entry 1 (pinned, every project)\n\nEvery repo ships with tests.',
      );
      expect(input).toContain('### Entry 2 (example)\n\nExample uses pnpm.');
      expect(input).toContain(
        `- [sample] wren (${builder}), holding no ticket`,
      );
      expect(voyage.notebook.map(({ id }) => id)[0]).toBe(shared);

      for (const each of [lead, other]) {
        const { rows } = await each.store.db.query<{
          agentId: string;
          voyageId: string;
          voyage: number;
          sessionId: string;
        }>(
          `select agent_id as "agentId", payload ->> 'voyageId' as "voyageId",
                  (payload ->> 'voyage')::int as voyage,
                  payload ->> 'sessionId' as "sessionId"
           from events where project_id = $1 and kind = $2`,
          [each.store.projectId, VOYAGE_STARTED_EVENT],
        );
        expect(rows).toEqual([
          {
            agentId: each.agentId,
            voyageId: each.voyageId,
            voyage: 4,
            sessionId: voyage.sessionId,
          },
        ]);
      }
      const { rows: surfaced } = await sample.db.query<{ agentId: string }>(
        `select agent_id as "agentId" from events
         where project_id = $1 and kind = $2`,
        [sample.projectId, STUCK_SURFACED_EVENT],
      );
      expect(surfaced).toEqual([{ agentId: other.agentId }]);
    },
    TIMEOUT,
  );
});
