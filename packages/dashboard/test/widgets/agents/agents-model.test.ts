import { describe, expect, it } from 'vitest';
import { emptyTables } from '../../../src/api/index.js';
import {
  availableActions,
  killAck,
  UNEXPLAINED_FAILURE,
} from '../../../src/widgets/agents/agent-actions.js';
import { buildAgents } from '../../../src/widgets/agents/agents-model.js';
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
  failedEvent,
  killedEvent,
  project,
} from './fixtures.js';

const viewOf = (id: string) => {
  const found = buildAgents(agentsTables(), NOW).agents.find(
    (view) => view.id === id,
  );
  if (found === undefined) throw new Error(`no agent ${id}`);
  return found;
};

describe('agents model', () => {
  it('lists unretired agents by role, then name', () => {
    const { agents, showProject } = buildAgents(agentsTables(), NOW);
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
    expect(buildAgents(tables, NOW).agents).toHaveLength(4);
    tables.projects.push(project(OTHER_PROJECT_ID, 'site'));
    const known = buildAgents(tables, NOW);
    expect(known.agents).toHaveLength(5);
    expect(known.showProject).toBe(true);
  });

  it('shows state, since, the ticket worked on and every held ticket', () => {
    expect(viewOf(BUILDER_ID)).toMatchObject({
      project: 'deck',
      stateLabel: 'working',
      since: '5m ago',
      workingOn: 'QD8c Agents widget',
      hasWork: true,
      held: [
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
      isLive: true,
      isPaused: false,
    });
    expect(viewOf(PAUSED_ID)).toMatchObject({
      stateLabel: 'paused',
      since: '2h ago',
      workingOn: '',
      hasWork: false,
      held: [],
      isPaused: true,
    });
    expect(viewOf(KILLED_ID).isLive).toBe(false);
  });

  it('shows the tickets a kill blocked as held by the killed agent', () => {
    expect(viewOf(KILLED_ID)).toMatchObject({
      workingOn: 'QD5i kill / retire / reset',
      held: [
        {
          id: BLOCKED_TICKET_ID,
          title: 'QD5i kill / retire / reset',
          statusLabel: 'blocked',
        },
      ],
    });
  });

  it('is empty without agents', () => {
    expect(buildAgents(emptyTables(), NOW)).toEqual({
      agents: [],
      showProject: false,
    });
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
