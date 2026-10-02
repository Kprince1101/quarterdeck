import type { AgentRow } from '@quarterdeck/server/stream-schema';
import { DEMO_PLANNER_REPLY } from './demo-plans.js';
import { turnTokens } from './demo-script.js';
import type { DemoWorld } from './demo-world.js';

export const PLANNER_NAME = 'planner';

const MAX_TITLE = 80;

export interface DemoPlanner {
  agent: () => AgentRow;
  hear: (intentId: string, text: string) => number;
  reply: (seq: number, text: string) => void;
  clear: (intentId: string) => void;
}

const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? text;
  if (line.length <= MAX_TITLE) return line;
  return `${line.slice(0, MAX_TITLE - 1)}…`;
};

export const createDemoPlanner = (world: DemoWorld): DemoPlanner => {
  const { store } = world;
  const agent = (): AgentRow =>
    store
      .rows('agents')
      .find((row) => row.role === 'planner' && !world.isGone(row)) ??
    world.birth(PLANNER_NAME, 'planner', null, 'claude');

  return {
    agent,
    hear: (intentId, text) => {
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
        payload: { intentId, seq, text },
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
        `From the Planner conversation:\n\n${text}`,
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
        payload: { title: ticket.title },
      });
    },
    clear: (intentId) => {
      world.setAgent(agent(), 'retired');
      store.emit('planner.cleared', { payload: { reason: 'new', intentId } });
      agent();
    },
  };
};
