import type { AttachmentRef } from '@quarterdeck/server/intents';
import type { AgentRow } from '@quarterdeck/server/stream-schema';
import { specBody } from '@quarterdeck/server/ticket-spec';
import { DEMO_PLANNER_REPLY } from './demo-plans.js';
import { DEMO_PROJECT } from './demo-seed.js';
import { turnTokens } from './demo-script.js';
import type { DemoWorld } from './demo-world.js';

export const PLANNER_NAME = 'planner';

const MAX_TITLE = 80;

export interface DemoPlanner {
  agent: () => AgentRow;
  hear: (
    intentId: string,
    text: string,
    attachments?: readonly AttachmentRef[],
  ) => number;
  reply: (seq: number, text: string) => void;
  clear: (intentId: string) => void;
}

const IMAGE_ONLY_TITLE = 'What the attached image shows';

const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? text;
  if (line === '') return IMAGE_ONLY_TITLE;
  if (line.length <= MAX_TITLE) return line;
  return `${line.slice(0, MAX_TITLE - 1)}…`;
};

const demoSpec = (text: string): string =>
  specBody({
    intro: 'From the Planner conversation.',
    sections: {
      Requirements: `- As the person who asked, I want this built: ${text.trim()}\n  - WHEN a builder finishes the ticket THE SYSTEM SHALL do what that request describes.`,
      Design:
        'Read the repository first and change only the code the request touches.',
      Tasks:
        '1. Find the code the request touches.\n2. Make the change, with tests.\n3. Open a pull request.',
    },
    proven: 'the new tests pass and show the request working.',
  });

export const createDemoPlanner = (world: DemoWorld): DemoPlanner => {
  const { store } = world;
  const agent = (): AgentRow =>
    store
      .rows('agents')
      .find((row) => row.role === 'planner' && !world.isGone(row)) ??
    world.birth(PLANNER_NAME, 'planner', null, 'claude');

  return {
    agent,
    hear: (intentId, text, attachments = []) => {
      const planner = world.setAgent(agent(), 'working');
      const seq =
        Math.max(
          0,
          ...store
            .rows('turns')
            .filter((turn) => turn.agentId === planner.id)
            .map((turn) => turn.seq),
        ) + 1;
      store.emit('planner.human', {
        agentId: planner.id,
        payload: { intentId, seq, text, attachments: [...attachments] },
      });
      return seq;
    },
    reply: (seq, text) => {
      const planner = agent();
      world.turn(planner, null, turnTokens('planner', seq), {
        input: text,
        output: DEMO_PLANNER_REPLY,
      });
      world.setAgent(planner, 'idle');
      const ticket = world.createTicket(
        titleOf(text),
        demoSpec(text),
        'proposed',
        null,
      );
      store.emit('planner.reply', {
        agentId: planner.id,
        payload: { seq, text: DEMO_PLANNER_REPLY, stopReason: 'end_turn' },
      });
      store.emit('ticket.proposed', {
        agentId: planner.id,
        ticketId: ticket.id,
        payload: {
          title: ticket.title,
          project: DEMO_PROJECT,
          ticketId: ticket.id,
        },
      });
    },
    clear: (intentId) => {
      world.setAgent(agent(), 'retired');
      store.emit('planner.cleared', { payload: { reason: 'new', intentId } });
      agent();
    },
  };
};
