import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startQuarterdeck,
  type Quarterdeck,
} from '../../src/quarterdeck/index.js';
import type { Store } from '../../src/store/index.js';
import {
  TIMEOUT,
  WAIT,
  createRepo,
  crewRuntime,
  eventsOf,
  fakeGitHub,
  proposeTicket,
  sendIntent,
  storeOf,
  writeMachineRule,
} from './crew-fixtures.ts';

const PROJECTS = ['example', 'sample'] as const;

const MCP_TRACKER = {
  kind: 'tracker-mcp',
  how: 'mcp',
  server: 'tracker-mcp',
  notes: 'tickets are stories in the Example board',
};

const CLI_TRACKER = { kind: 'tracker-cli', how: 'cli', command: 'tracker' };

const EXAMPLE_TRACKER_LINE =
  '- Tracker: tracker-mcp, reached through the `tracker-mcp` MCP server. Notes: tickets are stories in the Example board';
const SAMPLE_TRACKER_LINE =
  '- Tracker: tracker-cli, reached with the `tracker` CLI.';
const FORGE_LINE =
  '- Forge: GitHub at github.com. Use the `gh` CLI for pull requests, reviews and checks.';

const turnPrompts = async (
  store: Store,
  role: string,
  ticketId: string | null,
): Promise<string[]> => {
  const { rows } = await store.db.query<{ prompt: string }>(
    `select t.prompt from turns t join agents a on a.id = t.agent_id
     where a.project_id = $1 and a.role = $2
       and t.ticket_id is not distinct from $3
     order by t.id`,
    [store.projectId, role, ticketId],
  );
  return rows.map(({ prompt }) => prompt);
};

const projectBlock = (birth: string, project: string): string => {
  const start = birth.indexOf(`## ${project}\n`);
  const next = birth.indexOf('\n## ', start + 1);
  const notebook = birth.indexOf('\n# Notebook', start);
  const end = [next, notebook].filter((at) => at > start);
  return birth.slice(start, Math.min(...end));
};

describe('project services in agent prompts', { timeout: TIMEOUT }, () => {
  let homeDir = '';
  const cleanup: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'qd-services-'));
    await writeMachineRule(homeDir, 'lifecycle.json', {
      autoEndSettleSeconds: 1,
      mergeGate: { autoMerge: false },
    });
    await writeMachineRule(homeDir, 'services.json', {
      projects: { sample: { tracker: CLI_TRACKER } },
    });
  });

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    await rm(homeDir, { recursive: true, force: true });
  });

  const start = async (): Promise<Quarterdeck> => {
    const runtime = crewRuntime({});
    const qd = await startQuarterdeck({
      port: 0,
      homeDir,
      adapters: runtime.adapters,
      forge: fakeGitHub(),
    });
    cleanup.push(() => qd.close());
    for (const project of PROJECTS) {
      const repo = await createRepo();
      cleanup.push(() => rm(repo, { recursive: true, force: true }));
      const created = await sendIntent(qd, 'project.create', {
        project,
        repoPath: repo,
      });
      expect(created.status).toBe(200);
    }
    return qd;
  };

  it("shows each ticket's project services and its external_ref to the Driver, builders and reviewer", async () => {
    const qd = await start();
    const set = await sendIntent(qd, 'services.set', {
      project: 'example',
      tracker: MCP_TRACKER,
    });
    expect(set.status).toBe(200);
    const [example, sample] = PROJECTS.map((project) =>
      storeOf(qd, project),
    ) as [Store, Store];

    const started = await sendIntent(qd, 'voyage.start', { goal: 'Ship both' });
    expect(started.status).toBe(200);
    for (const store of [example, sample]) {
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'driver.voyage_started')).toHaveLength(1);
      }, WAIT);
    }
    const birthPrompt = async (): Promise<string> => {
      const births = [
        ...(await turnPrompts(example, 'driver', null)),
        ...(await turnPrompts(sample, 'driver', null)),
      ];
      return births.find((prompt) => prompt.includes('# Projects')) ?? '';
    };
    await vi.waitFor(async () => {
      expect(await birthPrompt()).not.toBe('');
    }, WAIT);
    const birth = await birthPrompt();
    const exampleBlock = projectBlock(birth, 'example');
    const sampleBlock = projectBlock(birth, 'sample');
    expect(exampleBlock).toContain(`Services:\n\n${FORGE_LINE}`);
    expect(exampleBlock).toContain(EXAMPLE_TRACKER_LINE);
    expect(exampleBlock).not.toContain(SAMPLE_TRACKER_LINE);
    expect(sampleBlock).toContain(SAMPLE_TRACKER_LINE);
    expect(sampleBlock).not.toContain(EXAMPLE_TRACKER_LINE);

    const exampleTicket = await proposeTicket(example, 'Add a greeting');
    const sampleTicket = await proposeTicket(sample, 'Add a greeting');
    await example.db.query(
      `update tickets set external_ref = 'EX-42' where id = $1`,
      [exampleTicket],
    );
    for (const [project, ticketId] of [
      ['example', exampleTicket],
      ['sample', sampleTicket],
    ]) {
      const approved = await sendIntent(qd, 'ticket.approve', {
        project,
        ticketId,
      });
      expect(approved.status).toBe(200);
    }

    for (const [store, ticketId] of [
      [example, exampleTicket],
      [sample, sampleTicket],
    ] as const) {
      await vi.waitFor(async () => {
        expect(await eventsOf(store, 'ticket.verdict')).toHaveLength(1);
      }, WAIT);
      expect(await turnPrompts(store, 'builder', ticketId)).not.toEqual([]);
    }

    const [exampleAssignment] = await turnPrompts(
      example,
      'builder',
      exampleTicket,
    );
    expect(exampleAssignment).toContain(`# Services\n\n${FORGE_LINE}`);
    expect(exampleAssignment).toContain(EXAMPLE_TRACKER_LINE);
    expect(exampleAssignment).toContain('- This ticket in the tracker: EX-42');
    expect(exampleAssignment).not.toContain(SAMPLE_TRACKER_LINE);

    const [sampleAssignment] = await turnPrompts(
      sample,
      'builder',
      sampleTicket,
    );
    expect(sampleAssignment).toContain(SAMPLE_TRACKER_LINE);
    expect(sampleAssignment).not.toContain(EXAMPLE_TRACKER_LINE);
    expect(sampleAssignment).not.toContain('This ticket in the tracker');

    const [exampleReview] = await turnPrompts(
      example,
      'reviewer',
      exampleTicket,
    );
    expect(exampleReview).toContain(EXAMPLE_TRACKER_LINE);
    expect(exampleReview).toContain('- This ticket in the tracker: EX-42');
    const [sampleReview] = await turnPrompts(sample, 'reviewer', sampleTicket);
    expect(sampleReview).toContain(SAMPLE_TRACKER_LINE);
    expect(sampleReview).not.toContain(EXAMPLE_TRACKER_LINE);
  });
});
