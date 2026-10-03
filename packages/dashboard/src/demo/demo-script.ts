import { forgeTerms } from '@quarterdeck/rules/forges';
import type {
  AgentRow,
  CardRow,
  VoyageRow,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import {
  DEMO_VOYAGE_PLANS,
  type DemoQuestionPlan,
  type DemoVoyagePlan,
} from './demo-plans.js';
import { DEMO_FORGE } from './demo-seed.js';
import type { DemoTurnText, DemoWorld, TurnTokens } from './demo-world.js';

export type DemoBeat = () => boolean;

export const CARD_PATIENCE_BEATS = 12;

const WORK_WHILE_WAITING_EVERY = 3;

const HANDS_OFF_TICKETS: ReadonlySet<TicketRow['status']> = new Set([
  'blocked',
  'done',
  'cancelled',
  'rejected',
]);

const TOKENS: Record<AgentRow['role'], TurnTokens> = {
  planner: { input: 6_200, output: 900 },
  driver: { input: 11_400, output: 1_350 },
  builder: { input: 52_800, output: 4_900 },
  reviewer: { input: 23_600, output: 2_100 },
};

const SPREAD = 41;
const STRIDE = 37;
const PERCENT = 100;
const LOW = 0.8;

export const turnTokens = (
  role: AgentRow['role'],
  seed: number,
): TurnTokens => {
  const factor = LOW + ((seed * STRIDE) % SPREAD) / PERCENT;
  return {
    input: Math.round(TOKENS[role].input * factor),
    output: Math.round(TOKENS[role].output * factor),
  };
};

const SHA_LENGTH = 40;
const PR_STRIDE = 10;

const pr = (voyage: VoyageRow, index: number): string =>
  `https://github.com/demo/harbor/pull/${voyage.number * PR_STRIDE + index}`;

const sha = (voyage: VoyageRow, index: number): string =>
  `${voyage.number}${index}`
    .padEnd(SHA_LENGTH, '7e3a91c05d')
    .slice(0, SHA_LENGTH);

export interface DemoScriptOptions {
  names: readonly string[];
  answerCards?: boolean;
}

export const planOf = (number: number): DemoVoyagePlan => {
  const plan = DEMO_VOYAGE_PLANS[(number - 1) % DEMO_VOYAGE_PLANS.length];
  if (plan === undefined) throw new Error('No demo voyage plans');
  return plan;
};

export const freeName = (
  world: DemoWorld,
  names: readonly string[],
): string => {
  const agents = world.store.rows('agents');
  const taken = new Set(
    agents.filter((agent) => !world.isGone(agent)).map((agent) => agent.name),
  );
  const free = names.filter((name) => !taken.has(name));
  return (
    free[agents.length % Math.max(1, free.length)] ??
    `agent-${agents.length + 1}`
  );
};

const builderText = (ticket: TicketRow, step: string): DemoTurnText => ({
  input: `Ticket: ${ticket.title}\n\n${ticket.body}\n\n${step}`,
  output: `${step} Done; the tests pass locally.`,
});

const reviewerText = (ticket: TicketRow, verdict: string): DemoTurnText => ({
  input: `Review ${ticket.prUrl ?? `the ${forgeTerms(DEMO_FORGE).long}`} for "${ticket.title}".`,
  output: verdict,
});

const askCard = (
  world: DemoWorld,
  agent: AgentRow,
  ticket: TicketRow,
  plan: DemoQuestionPlan,
  options: DemoScriptOptions,
): CardRow => {
  const card = world.ask(
    agent,
    ticket,
    plan.question,
    plan.options,
    plan.recommendation,
  );
  if (options.answerCards !== true) return card;
  return world.settleCard(card, plan.recommendation);
};

const proposeLesson = (
  world: DemoWorld,
  voyage: VoyageRow,
  driver: AgentRow,
  lesson: string,
): void => {
  const { store } = world;
  const id = store.newId();
  store.put('notebook_proposals', {
    id,
    projectId: store.projectId,
    voyageId: voyage.id,
    agentId: driver.id,
    op: 'add',
    entryId: null,
    body: lesson,
    pinned: false,
    rationale: `Learned in voyage ${voyage.number}.`,
    status: 'open',
    createdAt: store.now(),
    decidedAt: null,
  });
  store.emit('notebook.proposed', {
    agentId: driver.id,
    payload: { proposalId: id, op: 'add' },
  });
};

const voyageCrew = (world: DemoWorld, voyageId: string): AgentRow[] =>
  world.store.rows('agents').filter((agent) => agent.voyageId === voyageId);

const crewMember = (
  world: DemoWorld,
  voyageId: string,
  role: AgentRow['role'],
  nth = 0,
): AgentRow | undefined =>
  voyageCrew(world, voyageId).filter((agent) => agent.role === role)[nth];

const voyageTickets = (world: DemoWorld, voyageId: string): TicketRow[] =>
  world.store.rows('tickets').filter((ticket) => ticket.voyageId === voyageId);

export const voyageBeats = (
  world: DemoWorld,
  voyage: VoyageRow,
  options: DemoScriptOptions,
): DemoBeat[] => {
  const { store } = world;
  const plan = planOf(voyage.number);
  const agent = (role: AgentRow['role'], nth = 0): AgentRow | undefined => {
    const row = crewMember(world, voyage.id, role, nth);
    if (row === undefined || world.isGone(row) || row.status === 'paused') {
      return undefined;
    }
    return row;
  };
  const ticket = (nth: number): TicketRow | undefined => {
    const row = voyageTickets(world, voyage.id)[nth];
    if (row === undefined || HANDS_OFF_TICKETS.has(row.status)) {
      return undefined;
    }
    return row;
  };
  const work = (
    role: AgentRow['role'],
    nth: number,
    on: TicketRow | null,
    text: (row: AgentRow) => DemoTurnText,
  ): void => {
    const row = agent(role, nth);
    if (row === undefined) return;
    let working = row;
    if (row.status !== 'working') working = world.setAgent(row, 'working');
    const tokens = turnTokens(role, store.rows('turns').length);
    world.turn(working, on, tokens, text(working));
  };
  const rest = (role: AgentRow['role'], nth = 0): void => {
    const row = agent(role, nth);
    if (row !== undefined && row.status !== 'idle') world.setAgent(row, 'idle');
  };
  const move = (
    nth: number,
    status: TicketRow['status'],
    fields: Partial<TicketRow> = {},
  ): void => {
    const row = ticket(nth);
    if (row !== undefined) world.moveTicket(row, status, fields);
  };
  const build = (
    role: AgentRow['role'],
    nth: number,
    on: number,
    step: string,
  ) => {
    const row = ticket(on);
    if (row === undefined) return;
    work(role, nth, row, () => builderText(row, step));
  };
  const review = (on: number, verdict: string) => {
    const row = ticket(on);
    if (row === undefined) return;
    work('reviewer', 0, row, () => reviewerText(row, verdict));
  };
  const merge = (on: number) => {
    const row = ticket(on);
    if (row === undefined) return;
    world.moveTicket(row, 'done');
    store.emit('ticket.merged', {
      ticketId: row.id,
      payload: { title: row.title, prUrl: row.prUrl },
    });
  };
  const assignee = (nth: number) => agent('builder', nth)?.id ?? null;
  const card = () =>
    store
      .rows('cards')
      .findLast(
        (row) => row.ticketId === voyageTickets(world, voyage.id)[1]?.id,
      );
  let waited = 0;

  const planVoyage = (): boolean => {
    const driver = world.birth(
      freeName(world, options.names),
      'driver',
      voyage.id,
    );
    world.activateVoyage(voyage);
    work('driver', 0, null, () => ({
      input: `Voyage ${voyage.number}. Goal: ${voyage.goal}. Read the notebook and the open tickets, then plan the voyage.`,
      output: `${driver.name}: three tickets fit the goal. Two builders and a reviewer; the second builder takes the riskiest ticket.`,
    }));
    return true;
  };

  const assign = (): boolean => {
    const isUnplanned = (row: TicketRow) =>
      row.voyageId === null ||
      store.find('voyages', row.voyageId)?.status === 'ended';
    const waiting = store
      .rows('tickets')
      .filter((row) => row.status === 'open' && isUnplanned(row))
      .slice(0, plan.tickets.length);
    waiting.forEach((row) =>
      store.patch('tickets', row.id, { voyageId: voyage.id }),
    );
    plan.tickets
      .slice(waiting.length)
      .forEach((row) =>
        world.createTicket(row.title, row.body, 'open', voyage.id),
      );
    world.birth(freeName(world, options.names), 'builder', voyage.id);
    world.birth(freeName(world, options.names), 'builder', voyage.id, 'claude');
    world.birth(freeName(world, options.names), 'reviewer', voyage.id);
    move(0, 'assigned', { assigneeId: assignee(0) });
    move(1, 'assigned', { assigneeId: assignee(1) });
    work('driver', 0, null, () => ({
      input: 'Assign the voyage.',
      output: voyageTickets(world, voyage.id)
        .map((row, at) => `${at + 1}. ${row.title}`)
        .join('\n'),
    }));
    rest('driver');
    return true;
  };

  return [
    () => true,
    planVoyage,
    assign,
    () => {
      move(0, 'in_progress');
      move(1, 'in_progress');
      build('builder', 0, 0, 'Read the ticket and the code around it.');
      build('builder', 1, 1, 'Read the ticket and the code around it.');
      return true;
    },
    () => {
      const [asker, on] = [agent('builder', 1), ticket(1)];
      if (asker !== undefined && on !== undefined) {
        askCard(world, asker, on, plan.question, options);
      }
      build('builder', 0, 0, 'Write the change and its tests.');
      return true;
    },
    () => {
      move(0, 'in_review', { prUrl: pr(voyage, 1), headSha: sha(voyage, 1) });
      rest('builder', 0);
      review(0, 'Approved: the tests cover the change.');
      return true;
    },
    () => {
      merge(0);
      rest('reviewer');
      move(2, 'assigned', { assigneeId: assignee(0) });
      move(2, 'in_progress');
      build('builder', 0, 2, 'Read the ticket and the code around it.');
      return true;
    },
    ...Array.from({ length: CARD_PATIENCE_BEATS }, () => () => {
      if (card()?.status !== 'open') return false;
      if (waited % WORK_WHILE_WAITING_EVERY === 0) {
        build('builder', 0, 2, 'Keep going while the card waits.');
      }
      waited += 1;
      return true;
    }),
    () => {
      const open = card();
      if (open?.status === 'open') world.expireCard(open, 'nobody answered');
      const answer = card()?.answer ?? plan.question.recommendation;
      build('builder', 1, 1, `Go with "${answer}" and finish the change.`);
      return true;
    },
    () => {
      move(1, 'in_review', { prUrl: pr(voyage, 2), headSha: sha(voyage, 2) });
      rest('builder', 1);
      review(1, 'Bounced: the new path has no test for a cancelled booking.');
      move(1, 'bounced');
      return true;
    },
    () => {
      build('builder', 1, 1, 'Add the missing test and push.');
      move(1, 'in_review', { headSha: sha(voyage, 3) });
      move(2, 'in_review', { prUrl: pr(voyage, 3), headSha: sha(voyage, 4) });
      rest('builder', 0);
      rest('builder', 1);
      return true;
    },
    () => {
      review(1, 'Approved: the test is there now.');
      merge(1);
      return true;
    },
    () => {
      review(2, 'Approved.');
      merge(2);
      rest('reviewer');
      return true;
    },
    () => {
      const driver = agent('driver');
      work('driver', 0, null, () => ({
        input: 'Every ticket is merged. Wrap up the voyage.',
        output: `Voyage ${voyage.number} is done. One lesson for the notebook.`,
      }));
      if (driver !== undefined) {
        proposeLesson(world, voyage, driver, plan.lesson);
      }
      rest('driver');
      return true;
    },
    () => {
      world.endVoyage(voyage, 'ended');
      return true;
    },
  ];
};
