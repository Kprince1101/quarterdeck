import type { StreamEvent } from '@quarterdeck/server/stream-schema';
import { describe, expect, it } from 'vitest';
import { emptyTables } from '../../../src/api/index.js';
import {
  availableActions,
  killAck,
  UNEXPLAINED_FAILURE,
} from '../../../src/widgets/agents/agent-actions.js';
import { buildAgents } from '../../../src/widgets/agents/agents-model.js';
import { heldWorkBy } from '../../../src/widgets/agents/held-work.js';
import {
  BLOCKED_TICKET_ID,
  BUILDER_ID,
  DRIVER_ID,
  INTENT_ID,
  KILLED_ID,
  NOW,
  OTHER_PROJECT_ID,
  PAUSED_ID,
  REVIEW_TICKET_ID,
  TICKET_ID,
  agent,
  agentsTables,
  droppedEvent,
  failedEvent,
  heldEvent,
  killedEvent,
  project,
  replayedEvent,
} from './fixtures.js';

const viewOf = (id: string, events: readonly StreamEvent[] = []) => {
  const found = buildAgents(agentsTables(), events, NOW).agents.find(
    (view) => view.id === id,
  );
  if (found === undefined) throw new Error(`no agent ${id}`);
  return found;
};

const waiting = heldEvent(1, PAUSED_ID, 'continue: fix lint');
const replayed = heldEvent(2, PAUSED_ID, 'turn: replayed');
const dropped = heldEvent(3, PAUSED_ID, 'assign: dropped');
const elsewhere = heldEvent(4, DRIVER_ID, 'turn: plan voyage 2');
const later = heldEvent(5, PAUSED_ID, 'continue: rebase', [
  'global',
  'project',
]);
const unowned = heldEvent(6, null, 'reassign: QD8c');

const PAUSE_EVENTS: StreamEvent[] = [
  waiting,
  replayed,
  dropped,
  elsewhere,
  later,
  unowned,
  replayedEvent(7, replayed),
  droppedEvent(8, dropped),
];

describe('agents model', () => {
  it('lists unretired agents by role, then name', () => {
    const { agents, showProject } = buildAgents(agentsTables(), [], NOW);
    expect(agents.map(({ name }) => name)).toEqual([
      'gull',
      'finch',
      'heron',
      'tansy',
    ]);
    expect(showProject).toBe(false);
  });

  it('leaves out agents of projects it does not know', () => {
    const tables = agentsTables();
    tables.agents.push(
      agent('00000000-0000-4000-8000-0000000000b9', 'stray', {
        projectId: OTHER_PROJECT_ID,
      }),
    );
    expect(buildAgents(tables, [], NOW).agents).toHaveLength(4);
    tables.projects.push(project(OTHER_PROJECT_ID, 'site'));
    const known = buildAgents(tables, [], NOW);
    expect(known.agents).toHaveLength(5);
    expect(known.showProject).toBe(true);
  });

  it('shows state, since, the ticket worked on and every ticket it has', () => {
    expect(viewOf(BUILDER_ID)).toMatchObject({
      project: 'deck',
      stateLabel: 'working',
      since: '5m ago',
      workingOn: 'QD8c Agents widget',
      hasWork: true,
      tickets: [
        {
          id: TICKET_ID,
          title: 'QD8c Agents widget',
          statusLabel: 'in progress',
        },
        {
          id: REVIEW_TICKET_ID,
          title: 'QD8a Board widget',
          statusLabel: 'in review',
        },
      ],
      held: [],
      isLive: true,
      isPaused: false,
    });
    expect(viewOf(PAUSED_ID)).toMatchObject({
      stateLabel: 'paused',
      since: '2h ago',
      workingOn: '',
      hasWork: false,
      tickets: [],
      isPaused: true,
    });
    expect(viewOf(KILLED_ID).isLive).toBe(false);
  });

  it('shows the tickets a kill blocked on the killed agent', () => {
    expect(viewOf(KILLED_ID)).toMatchObject({
      workingOn: 'QD5i kill / retire / reset',
      tickets: [
        {
          id: BLOCKED_TICKET_ID,
          title: 'QD5i kill / retire / reset',
          statusLabel: 'blocked',
        },
      ],
    });
  });

  it('shows the work the pause gate holds for each agent, oldest first', () => {
    expect(viewOf(PAUSED_ID, PAUSE_EVENTS).held).toEqual([
      {
        eventId: 1,
        label: 'continue: fix lint',
        scopes: ['agent'],
        text: 'held: continue: fix lint (agent)',
      },
      {
        eventId: 5,
        label: 'continue: rebase',
        scopes: ['global', 'project'],
        text: 'held: continue: rebase (global, project)',
      },
    ]);
    expect(viewOf(DRIVER_ID, PAUSE_EVENTS).held).toEqual([
      {
        eventId: 4,
        label: 'turn: plan voyage 2',
        scopes: ['agent'],
        text: 'held: turn: plan voyage 2 (agent)',
      },
    ]);
    expect(viewOf(BUILDER_ID, PAUSE_EVENTS).held).toEqual([]);
  });

  it('is empty without agents', () => {
    expect(buildAgents(emptyTables(), PAUSE_EVENTS, NOW)).toEqual({
      agents: [],
      showProject: false,
    });
  });
});

describe('held work', () => {
  it('drops a held item once it is replayed or dropped', () => {
    expect(heldWorkBy([waiting]).get(PAUSED_ID)).toHaveLength(1);
    expect(
      heldWorkBy([waiting, replayedEvent(9, waiting)]).has(PAUSED_ID),
    ).toBe(false);
    expect(heldWorkBy([waiting, droppedEvent(9, waiting)]).has(PAUSED_ID)).toBe(
      false,
    );
  });

  it('skips held events without an agent or a label', () => {
    const unlabelled = { ...heldEvent(9, PAUSED_ID, ''), payload: {} };
    expect([...heldWorkBy([unowned, unlabelled]).keys()]).toEqual([]);
  });

  it('labels work held with no scopes without them', () => {
    expect(
      heldWorkBy([heldEvent(9, PAUSED_ID, 'launch', [])]).get(PAUSED_ID),
    ).toEqual([
      { eventId: 9, label: 'launch', scopes: [], text: 'held: launch' },
    ]);
  });
});

describe('agent actions', () => {
  it('offers pause or resume to live agents and only retire to finished ones', () => {
    expect(availableActions(viewOf(DRIVER_ID))).toEqual([
      'pause',
      'poke',
      'kill',
      'retire',
      'reset',
    ]);
    expect(availableActions(viewOf(PAUSED_ID))).toEqual([
      'resume',
      'poke',
      'kill',
      'retire',
      'reset',
    ]);
    expect(availableActions(viewOf(KILLED_ID))).toEqual(['retire', 'reset']);
  });

  it('finds the ack the stream records for a kill', () => {
    const other = '00000000-0000-4000-8000-0000000000f2';
    const events = [failedEvent(1, other), failedEvent(2, INTENT_ID)];
    expect(killAck(events, INTENT_ID)).toEqual({
      failure: 'session would not close',
    });
    expect(killAck(events, null)).toBeNull();
    expect(killAck([failedEvent(1, other)], INTENT_ID)).toBeNull();
    expect(killAck([killedEvent(3, INTENT_ID)], INTENT_ID)).toEqual({
      failure: null,
    });
    expect(killAck([killedEvent(3, other)], INTENT_ID)).toBeNull();
    expect(
      killAck([failedEvent(4, INTENT_ID, { error: '' })], INTENT_ID),
    ).toEqual({ failure: UNEXPLAINED_FAILURE });
    const unexplained = {
      ...failedEvent(5, INTENT_ID),
      payload: { intentId: INTENT_ID },
    };
    expect(killAck([unexplained], INTENT_ID)).toEqual({
      failure: UNEXPLAINED_FAILURE,
    });
    const elsewhere = { ...failedEvent(6, INTENT_ID), kind: 'agent.retired' };
    expect(killAck([elsewhere], INTENT_ID)).toBeNull();
  });
});
