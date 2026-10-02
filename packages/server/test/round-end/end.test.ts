import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { loadRule } from '@quarterdeck/rules';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLifecycle } from '../../src/agents/index.js';
import { openDriverRound } from '../../src/driver/index.js';
import {
  ROUND_ENDED_EVENT,
  startRoundAutoEnd,
  type EndedRound,
} from '../../src/round-end/index.js';
import type { Store } from '../../src/store/index.js';
import { fakeWorktrees } from '../agents/fixtures.js';
import { startTestApi, type TestApi } from '../api/harness.js';
import {
  resultText,
  say,
  startScriptedAgent,
  type ScriptedAgent,
} from '../driver/scripted-agent.js';
import {
  TIMEOUT,
  eventPayloads,
  fakeScheduler,
  insertAgent,
  insertRound,
  lenientSessions,
} from './fixtures.js';

const project = 'wrap';
const NEW_CHARTER = '# Driver charter\n\nShip small, ship often.';
const BUS: McpServerStdio = {
  name: 'quarterdeck',
  command: 'node',
  args: ['relay.js'],
  env: [],
};
const BIRTH = { summary: 'Nothing to assign.', actions: [] };

describe('a settled round, end to end', { timeout: TIMEOUT }, () => {
  let t: TestApi;
  let store: Store;
  let scripted: ScriptedAgent;
  let repoDir = '';
  let turnsDir = '';

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'qd-repo-'));
    turnsDir = await mkdtemp(join(tmpdir(), 'qd-turns-'));
    t = await startTestApi();
    await t.send('project.create', { project, repoPath: repoDir });
    store = await t.store(project);
    scripted = await startScriptedAgent();
  }, TIMEOUT);

  afterAll(async () => {
    await scripted.client.close();
    await t.close();
    await rm(repoDir, { recursive: true, force: true });
    await rm(turnsDir, { recursive: true, force: true });
  });

  const charter = () => loadRule('charter', { homeDir: t.homeDir, repoDir });

  const openRound = async (number: number, name: string) => {
    const roundId = await insertRound(store, number);
    const agentId = await insertAgent(store, {
      name,
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
      cwd: repoDir,
      charter: await charter(),
      turnsDir,
    });
    await round.birth;
    return round;
  };

  const decide = async (
    intent: 'notebook.decide' | 'charter.decide',
    proposalId: string,
    extra: Record<string, unknown> = {},
  ) => {
    const reply = await t.send(intent, {
      project,
      proposalId,
      decision: 'accepted',
      ...extra,
    });
    expect(reply.status).toBe(200);
    return reply.body.result as Record<string, unknown>;
  };

  it('wraps up, ends the round, and the next Driver is born with what was approved', async () => {
    const added = await t.send('notebook.add', {
      project,
      body: 'Deploy on Fridays.',
    });
    const staleId = (added.body.result as { entryId: string }).entryId;
    const first = await openRound(1, 'lark');
    const scheduler = fakeScheduler();
    const ended: EndedRound[] = [];
    const auto = await startRoundAutoEnd({
      store,
      round: first,
      charter: await charter(),
      lifecycle: createAgentLifecycle({
        naming: { theme: 'birds', names: ['lark', 'wren'] },
        sessions: lenientSessions(),
        worktrees: fakeWorktrees(),
        openStores: () => [store],
      }),
      settleSeconds: 120,
      schedule: scheduler.schedule,
      onEnded: (round) => {
        ended.push(round);
      },
    });
    await auto.check();
    expect(scheduler.live()).toHaveLength(1);

    scripted.reply(
      say(
        resultText({
          summary: 'Round 1 shipped nothing; the notebook was stale.',
          notebook: [
            { op: 'add', body: 'Never deploy on Fridays.', pinned: true },
            { op: 'retire', entry: staleId, rationale: 'Wrong.' },
          ],
          charter: { body: NEW_CHARTER, rationale: 'Shorter.' },
        }),
      ),
    );
    scheduler.live()[0]?.fire();
    await vi.waitFor(() => {
      expect(ended).toHaveLength(1);
    });
    await auto.close();

    const [result] = ended;
    if (result?.wrapUp.status !== 'proposed') throw new Error('no proposals');
    expect(result.cleanup).toMatchObject({
      round: 1,
      ended: true,
      retired: [first.agent.id],
    });
    expect(await eventPayloads(store, ROUND_ENDED_EVENT)).toHaveLength(1);
    const [addId, retireId] = result.wrapUp.notebookProposalIds;

    const accepted = await decide('notebook.decide', addId ?? '', {
      body: 'Never deploy on a Friday.',
    });
    expect(accepted).toMatchObject({ op: 'add', decision: 'accepted' });
    await decide('notebook.decide', retireId ?? '');
    await decide('charter.decide', result.wrapUp.charterProposalId ?? '');

    const second = await openRound(2, 'wren');

    expect(second.notebook.map((entry) => entry.body)).toEqual([
      'Never deploy on a Friday.',
    ]);
    expect(second.notebook[0]?.id).toBe(accepted['entryId']);
    const birth = scripted.prompts.at(-1)?.text ?? '';
    expect(birth).toContain(
      '### Entry 1 (pinned)\n\nNever deploy on a Friday.',
    );
    expect(birth).not.toContain('Deploy on Fridays.');
    expect(birth).toContain(NEW_CHARTER);
  });
});
