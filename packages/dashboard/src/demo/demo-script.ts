import type {
  AgentRow,
  CardRow,
  RoundRow,
  TicketRow,
} from '@quarterdeck/server/stream-schema';
import {
  DEMO_ROUND_PLANS,
  type DemoQuestionPlan,
  type DemoRoundPlan,
} from './demo-plans.js';
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

export const turnTokens = (role: AgentRow['role'], seed: number) => {
  const factor = LOW + ((seed * STRIDE) % SPREAD) / PERCENT;
  return {
    input: Math.round(TOKENS[role].input * factor),
    output: Math.round(TOKENS[role].output * factor),
  };
};

const SHA_LENGTH = 40;
const PR_STRIDE = 10;

const pr = (round: RoundRow, index: number): string =>
  `https://github.com/demo/harbor/pull/${round.number * PR_STRIDE + index}`;

const sha = (round: RoundRow, index: number): string =>
  `${round.number}${index}`
    .padEnd(SHA_LENGTH, '7e3a91c05d')
    .slice(0, SHA_LENGTH);

export interface DemoScriptOptions {
  names: readonly string[];
  answerCards?: boolean;
}

export const planOf = (number: number): DemoRoundPlan => {
  const plan = DEMO_ROUND_PLANS[(number - 1) % DEMO_ROUND_PLANS.length];
  if (plan === undefined) throw new Error('No demo round plans');
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
  input: `Review ${ticket.prUrl ?? 'the pull request'} for "${ticket.title}".`,
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
  round: RoundRow,
  driver: AgentRow,
  lesson: string,
): void => {
  const { store } = world;
  const id = store.newId();
  store.put('notebook_proposals', {
    id,
    projectId: store.projectId,
    roundId: round.id,
    agentId: driver.id,
    op: 'add',
    entryId: null,
    body: lesson,
    pinned: false,
    rationale: `Learned in round ${round.number}.`,
    status: 'open',
    createdAt: store.now(),
    decidedAt: null,
  });
  store.emit('notebook.proposed', {
    agentId: driver.id,
    payload: { proposalId: id, op: 'add' },
  });
};

const roundCrew = (world: DemoWorld, roundId: string): AgentRow[] =>
  world.store.rows('agents').filter((agent) => agent.roundId === roundId);

const crewMember = (
  world: DemoWorld,
  roundId: string,
  role: AgentRow['role'],
  nth = 0,
): AgentRow | undefined =>
  roundCrew(world, roundId).filter((agent) => agent.role === role)[nth];

const roundTickets = (world: DemoWorld, roundId: string): TicketRow[] =>
  world.store.rows('tickets').filter((ticket) => ticket.roundId === roundId);

export const roundBeats = (
  world: DemoWorld,
  round: RoundRow,
  options: DemoScriptOptions,
): DemoBeat[] => {
  const { store } = world;
  const plan = planOf(round.number);
  const agent = (role: AgentRow['role'], nth = 0): AgentRow | undefined => {
    const row = crewMember(world, round.id, role, nth);
    if (row === undefined || world.isGone(row) || row.status === 'paused') {
      return undefined;
    }
    return row;
  };
  const ticket = (nth: number): TicketRow | undefined => {
    const row = roundTickets(world, round.id)[nth];
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
      .findLast((row) => row.ticketId === roundTickets(world, round.id)[1]?.id);
  let waited = 0;

  const planRound = (): boolean => {
    const driver = world.birth(
      freeName(world, options.names),
      'driver',
      round.id,
    );
    world.activateRound(round);
    work('driver', 0, null, () => ({
      input: `Round ${round.number}. Goal: ${round.goal}. Read the notebook and the open tickets, then plan the round.`,
      output: `${driver.name}: three tickets fit the goal. Two builders and a reviewer; the second builder takes the riskiest ticket.`,
    }));
    return true;
  };

  const assign = (): boolean => {
    const isUnplanned = (row: TicketRow) =>
      row.roundId === null ||
      store.find('rounds', row.roundId)?.status === 'ended';
    const waiting = store
      .rows('tickets')
      .filter((row) => row.status === 'open' && isUnplanned(row))
      .slice(0, plan.tickets.length);
    waiting.forEach((row) =>
      store.patch('tickets', row.id, { roundId: round.id }),
    );
    plan.tickets
      .slice(waiting.length)
      .forEach((row) =>
        world.createTicket(row.title, row.body, 'open', round.id),
      );
    world.birth(freeName(world, options.names), 'builder', round.id);
    world.birth(freeName(world, options.names), 'builder', round.id, 'claude');
    world.birth(freeName(world, options.names), 'reviewer', round.id);
    move(0, 'assigned', { assigneeId: assignee(0) });
    move(1, 'assigned', { assigneeId: assignee(1) });
    work('driver', 0, null, () => ({
      input: 'Assign the round.',
      output: roundTickets(world, round.id)
        .map((row, at) => `${at + 1}. ${row.title}`)
        .join('\n'),
    }));
    rest('driver');
    return true;
  };

  return [
    () => true,
    planRound,
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
      move(0, 'in_review', { prUrl: pr(round, 1), headSha: sha(round, 1) });
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
      move(1, 'in_review', { prUrl: pr(round, 2), headSha: sha(round, 2) });
      rest('builder', 1);
      review(1, 'Bounced: the new path has no test for a cancelled booking.');
      move(1, 'bounced');
      return true;
    },
    () => {
      build('builder', 1, 1, 'Add the missing test and push.');
      move(1, 'in_review', { headSha: sha(round, 3) });
      move(2, 'in_review', { prUrl: pr(round, 3), headSha: sha(round, 4) });
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
        input: 'Every ticket is merged. Wrap up the round.',
        output: `Round ${round.number} is done. One lesson for the notebook.`,
      }));
      if (driver !== undefined) {
        proposeLesson(world, round, driver, plan.lesson);
      }
      rest('driver');
      return true;
    },
    () => {
      world.endRound(round, 'ended');
      return true;
    },
  ];
};
