import type {
  IntentName,
  IntentPayload,
  IntentReply,
  IntentResult,
  IntentStatus,
} from '@quarterdeck/server/intents';
import { presetLayout } from '@quarterdeck/server/layouts';
import type {
  LayoutRow,
  NotebookProposalRow,
  RoundRow,
} from '@quarterdeck/server/stream-schema';
import { DemoRefusal } from './demo-fetch.js';
import { DEMO_PROJECT } from './demo-seed.js';
import type { DemoPlanner } from './demo-planner.js';
import type { DemoReads } from './demo-reads.js';
import type { DemoRules } from './demo-rules.js';
import type { DemoWorld } from './demo-world.js';

const NOT_FOUND = 404;
const CONFLICT = 409;
const BAD_REQUEST = 400;
const NOT_IN_DEMO = 501;

export const PLANNER_HEAR_MS = 600;
export const PLANNER_REPLY_MS = 1800;

export interface DemoIntentContext {
  world: DemoWorld;
  rules: DemoRules;
  planner: DemoPlanner;
  reads: DemoReads;
  startRound: (goal: string) => RoundRow;
  later: (ms: number, work: () => void) => void;
}

type Handler<N extends IntentName> = (
  input: IntentPayload<N>,
  reply: (status: IntentStatus, result: IntentResult | null) => IntentReply,
) => IntentReply;

type Handlers = { [N in IntentName]: Handler<N> };

const UNRECORDED: ReadonlySet<IntentName> = new Set([
  'data.summary',
  'data.rows',
  'turn.read',
  'usage.read',
  'rules.write',
  'rules.reset',
]);

const refuse = (status: number, message: string): never => {
  throw new DemoRefusal(status, message);
};

const notInDemo = (what: string) => (): never =>
  refuse(NOT_IN_DEMO, `${what} is off in the demo: nothing is stored.`);

export const createDemoIntents = (
  ctx: DemoIntentContext,
): ((name: IntentName, input: unknown) => IntentReply) => {
  const { world, rules, planner, reads } = ctx;
  const { store } = world;

  const found = <T>(row: T | undefined, what: string): T => {
    if (row === undefined) return refuse(NOT_FOUND, `${what} not found`);
    return row;
  };
  const openRound = (roundId: string): RoundRow => {
    const round = found(store.find('rounds', roundId), `round ${roundId}`);
    if (round.status === 'ended') {
      refuse(CONFLICT, `Round ${round.number} has already ended`);
    }
    return round;
  };
  const openCard = (cardId: string) => {
    const card = found(store.find('cards', cardId), `card ${cardId}`);
    if (card.status !== 'open')
      refuse(CONFLICT, `card ${cardId} is ${card.status}`);
    return card;
  };
  const proposed = (ticketId: string) => {
    const ticket = found(store.find('tickets', ticketId), `ticket ${ticketId}`);
    if (ticket.status !== 'proposed') {
      refuse(CONFLICT, `ticket ${ticketId} is ${ticket.status}, not proposed`);
    }
    return ticket;
  };
  const agentOf = (agentId: string) =>
    found(store.find('agents', agentId), `agent ${agentId}`);
  const pausedAt = (paused: boolean) => (paused && store.now()) || null;
  const setPaused = (paused: boolean) => {
    const at = pausedAt(paused);
    store.patch('projects', store.projectId, {
      pausedAt: at,
      updatedAt: store.now(),
    });
    return { paused, pausedAt: at };
  };
  const setPausedEverywhere = (paused: boolean) => {
    store.setMachine({ pausedAt: pausedAt(paused) });
    return { paused, projects: [DEMO_PROJECT], failed: [] };
  };
  const pauseAgent = (agentId: string) => {
    const agent = agentOf(agentId);
    if (world.isGone(agent)) {
      refuse(CONFLICT, `agent ${agentId} is already ${agent.status}`);
    }
    return world.setAgent(agent, 'paused');
  };
  const resumeAgent = (agentId: string) => {
    const agent = agentOf(agentId);
    if (agent.status !== 'paused') {
      refuse(CONFLICT, `agent ${agentId} is not paused, it is ${agent.status}`);
    }
    return world.setAgent(agent, 'idle');
  };
  const acceptProposal = (
    proposal: NotebookProposalRow,
    body: string | null,
  ): string | null => {
    if (proposal.op === 'add') {
      const id = store.newId();
      store.put('notebook', {
        id,
        projectId: store.projectId,
        roundId: proposal.roundId,
        authorId: proposal.agentId,
        body: body ?? '',
        pinned: proposal.pinned,
        createdAt: store.now(),
        retiredAt: null,
      });
      return id;
    }
    if (proposal.entryId === null) return null;
    if (proposal.op === 'update') {
      store.patch('notebook', proposal.entryId, { body: body ?? '' });
    } else {
      store.patch('notebook', proposal.entryId, { retiredAt: store.now() });
    }
    return proposal.entryId;
  };
  const saveLayout = (name: string, spec: unknown) => {
    const existing = store.rows('layouts').find((row) => row.name === name);
    const at = store.now();
    const id = existing?.id ?? store.newId();
    store.put('layouts', {
      id,
      projectId: store.projectId,
      name,
      spec: spec as LayoutRow['spec'],
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    });
    return id;
  };

  const handlers: Handlers = {
    'round.start': (input, reply) => {
      const open = world.openRound();
      if (open !== undefined) {
        refuse(CONFLICT, `Round ${open.number} is still open; end it first`);
      }
      const round = ctx.startRound(input.goal);
      return reply('applied', { roundId: round.id, round: round.number });
    },
    'round.end': (input, reply) => {
      world.endRound(openRound(input.roundId), 'ended');
      return reply('applied', { roundId: input.roundId, ended: true });
    },
    'round.kill': (input, reply) => {
      world.endRound(openRound(input.roundId), 'killed');
      return reply('applied', { roundId: input.roundId, ended: true });
    },
    'pause.set': (input, reply) => reply('applied', setPaused(input.paused)),
    'pause.all': (input, reply) =>
      reply('applied', setPausedEverywhere(input.paused)),
    'agent.pause': (input, reply) => {
      const agent = pauseAgent(input.agentId);
      return reply('applied', { agentId: agent.id, status: agent.status });
    },
    'agent.resume': (input, reply) => {
      const agent = resumeAgent(input.agentId);
      return reply('applied', { agentId: agent.id, status: agent.status });
    },
    'agent.end': (input, reply) => {
      world.setAgent(agentOf(input.agentId), 'ended');
      return reply('applied', { agentId: input.agentId });
    },
    'agent.kill': (input, reply) => {
      world.setAgent(agentOf(input.agentId), 'killed');
      return reply('applied', { agentId: input.agentId });
    },
    'agent.retire': (input, reply) => {
      world.setAgent(agentOf(input.agentId), 'retired');
      return reply('applied', { agentId: input.agentId });
    },
    'agent.message': notInDemo('Messaging an agent'),
    'planner.message': (input, reply) => {
      const answer = reply('pending', null);
      const intentId = answer.id ?? '';
      ctx.later(PLANNER_HEAR_MS, () => {
        const seq = planner.hear(intentId, input.text);
        ctx.later(PLANNER_REPLY_MS, () => {
          planner.reply(seq, input.text);
        });
      });
      return answer;
    },
    'planner.new': (_input, reply) => {
      const answer = reply('pending', null);
      ctx.later(PLANNER_HEAR_MS, () => {
        planner.clear(answer.id ?? '');
      });
      return answer;
    },
    'card.answer': (input, reply) => {
      const card = openCard(input.cardId);
      const options = (card.options as string[] | null) ?? [];
      if (options.length > 0 && !options.includes(input.answer)) {
        refuse(BAD_REQUEST, 'The answer must be one of the card options');
      }
      world.settleCard(card, input.answer);
      return reply('applied', { cardId: card.id, status: 'answered' });
    },
    'card.decline': (input, reply) => {
      world.settleCard(openCard(input.cardId), null);
      return reply('applied', { cardId: input.cardId, status: 'declined' });
    },
    'notebook.add': (input, reply) => {
      const entryId = store.newId();
      store.put('notebook', {
        id: entryId,
        projectId: store.projectId,
        roundId: null,
        authorId: null,
        body: input.body,
        pinned: input.pinned,
        createdAt: store.now(),
        retiredAt: null,
      });
      return reply('applied', { entryId });
    },
    'notebook.pin': (input, reply) => {
      found(
        store.patch('notebook', input.entryId, { pinned: input.pinned }),
        `entry ${input.entryId}`,
      );
      return reply('applied', { entryId: input.entryId, pinned: input.pinned });
    },
    'notebook.remove': (input, reply) => {
      found(store.find('notebook', input.entryId), `entry ${input.entryId}`);
      store.remove('notebook', input.entryId);
      return reply('applied', { entryId: input.entryId });
    },
    'notebook.decide': (input, reply) => {
      const proposal = found(
        store.find('notebook_proposals', input.proposalId),
        `proposal ${input.proposalId}`,
      );
      if (proposal.status !== 'open') {
        refuse(CONFLICT, `proposal ${proposal.id} is ${proposal.status}`);
      }
      const body = input.body ?? proposal.body;
      store.patch('notebook_proposals', proposal.id, {
        status: input.decision,
        body,
        decidedAt: store.now(),
      });
      let entryId = proposal.entryId;
      if (input.decision === 'accepted') {
        entryId = acceptProposal(proposal, body);
      }
      return reply('applied', {
        proposalId: proposal.id,
        decision: input.decision,
        op: proposal.op,
        entryId,
      });
    },
    'charter.decide': (input, reply) => {
      found(
        store.patch('charter_proposals', input.proposalId, {
          status: input.decision,
          decidedAt: store.now(),
        }),
        `proposal ${input.proposalId}`,
      );
      return reply('applied', {
        proposalId: input.proposalId,
        decision: input.decision,
      });
    },
    'ticket.create': (input, reply) => {
      const ticket = world.createTicket(input.title, input.body, 'open', null);
      store.patch('tickets', ticket.id, { dependsOn: input.dependsOn });
      return reply('applied', { ticketId: ticket.id });
    },
    'ticket.update': (input, reply) => {
      const ticket = found(
        store.find('tickets', input.ticketId),
        `ticket ${input.ticketId}`,
      );
      store.patch('tickets', ticket.id, {
        title: input.title ?? ticket.title,
        body: input.body ?? ticket.body,
        dependsOn: input.dependsOn ?? ticket.dependsOn,
        updatedAt: store.now(),
      });
      return reply('applied', { ticketId: ticket.id });
    },
    'ticket.cancel': (input, reply) => {
      const ticket = found(
        store.find('tickets', input.ticketId),
        `ticket ${input.ticketId}`,
      );
      world.moveTicket(ticket, 'cancelled', { assigneeId: null });
      return reply('applied', { ticketId: ticket.id, status: 'cancelled' });
    },
    'ticket.approve': (input, reply) => {
      const ticket = proposed(input.ticketId);
      world.moveTicket(ticket, 'open', {
        title: input.title ?? ticket.title,
        body: input.body ?? ticket.body,
        dependsOn: input.dependsOn ?? ticket.dependsOn,
      });
      return reply('applied', { ticketId: ticket.id, status: 'open' });
    },
    'ticket.reject': (input, reply) => {
      world.moveTicket(proposed(input.ticketId), 'rejected');
      return reply('applied', { ticketId: input.ticketId, status: 'rejected' });
    },
    'project.create': notInDemo('Adding a project'),
    'project.update': notInDemo('Editing a project'),
    'project.archive': (input, reply) => {
      store.patch('projects', store.projectId, {
        archivedAt: (input.archived && store.now()) || null,
        updatedAt: store.now(),
      });
      return reply('applied', { archived: input.archived });
    },
    'rules.write': (input, reply) => {
      if (input.scope !== 'machine') return notInDemo('A repo rules layer')();
      rules.write(input.name, input.content);
      return reply('applied', { name: input.name, scope: input.scope });
    },
    'rules.reset': (input, reply) => {
      if (input.scope !== 'machine') return notInDemo('A repo rules layer')();
      rules.reset(input.name);
      return reply('applied', { name: input.name, scope: input.scope });
    },
    'layout.save': (input, reply) =>
      reply('applied', {
        layoutId: saveLayout(input.name, input.spec),
        name: input.name,
      }),
    'layout.reset': (input, reply) =>
      reply('applied', {
        layoutId: saveLayout(input.name, presetLayout(input.preset)),
        name: input.name,
        preset: input.preset,
      }),
    'layout.delete': (input, reply) => {
      const row = found(
        store.rows('layouts').find((layout) => layout.name === input.name),
        `layout ${input.name}`,
      );
      store.remove('layouts', row.id);
      return reply('applied', { name: input.name });
    },
    'wipe.project': notInDemo('Wiping'),
    'wipe.all': notInDemo('Wiping'),
    'data.summary': (_input, reply) => reply('applied', reads.summary()),
    'data.rows': (input, reply) =>
      reply('applied', reads.page(input.table, input.offset, input.limit)),
    'turn.read': (input, reply) => reply('applied', reads.turn(input.turnId)),
    'usage.read': (_input, reply) => reply('applied', reads.usage()),
  };

  return (name, input) => {
    const recorded = !UNRECORDED.has(name);
    const id = (recorded && store.newId()) || null;
    const reply = (status: IntentStatus, result: IntentResult | null) => {
      if (id !== null) store.emit(name, { payload: { intentId: id, status } });
      return { intent: name, status, id, result };
    };
    const handler = handlers[name] as Handler<IntentName>;
    return handler(input as IntentPayload<IntentName>, reply);
  };
};
