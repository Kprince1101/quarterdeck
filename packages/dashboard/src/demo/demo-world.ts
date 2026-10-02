import type {
  AgentRow,
  CardRow,
  RoundRow,
  TicketRow,
  TurnRow,
} from '@quarterdeck/server/stream-schema';
import type { DemoStore } from './demo-store.js';

export type AgentRole = AgentRow['role'];
export type AgentStatus = AgentRow['status'];
export type TicketStatus = TicketRow['status'];

const GONE: ReadonlySet<AgentStatus> = new Set(['ended', 'killed', 'retired']);

const ACTIVE_TICKETS: ReadonlySet<TicketStatus> = new Set([
  'assigned',
  'in_progress',
  'in_review',
  'bounced',
]);

export interface TurnTokens {
  input: number;
  output: number;
}

export interface DemoTurnText {
  input: string;
  output: string;
}

export interface DemoWorld {
  store: DemoStore;
  turnText: Map<number, DemoTurnText>;
  isGone: (agent: AgentRow) => boolean;
  isActiveTicket: (ticket: TicketRow) => boolean;
  openRound: () => RoundRow | undefined;
  livingAgents: (roundId: string) => AgentRow[];
  startRound: (goal: string) => RoundRow;
  activateRound: (round: RoundRow) => void;
  endRound: (round: RoundRow, reason: 'ended' | 'killed') => void;
  birth: (
    name: string,
    role: AgentRole,
    roundId: string | null,
    runtime?: AgentRow['runtime'],
  ) => AgentRow;
  setAgent: (agent: AgentRow, status: AgentStatus) => AgentRow;
  createTicket: (
    title: string,
    body: string,
    status: TicketStatus,
    roundId: string | null,
  ) => TicketRow;
  moveTicket: (
    ticket: TicketRow,
    status: TicketStatus,
    fields?: Partial<TicketRow>,
  ) => TicketRow;
  turn: (
    agent: AgentRow,
    ticket: TicketRow | null,
    tokens: TurnTokens,
    text: DemoTurnText,
  ) => TurnRow;
  ask: (
    agent: AgentRow,
    ticket: TicketRow | null,
    question: string,
    options: string[],
    recommendation: string | null,
  ) => CardRow;
  settleCard: (card: CardRow, answer: string | null) => CardRow;
  expireCard: (card: CardRow, reason: string) => CardRow;
}

const MS_PER_SECOND = 1000;

const TURN_SECONDS = 2;

export const DEMO_WORKTREES = '/home/demo/harbor-wt';

export const DEMO_TURNS_DIR = '/home/demo/.quarterdeck/harbor/turns';

export const createDemoWorld = (store: DemoStore): DemoWorld => {
  const turnText = new Map<number, DemoTurnText>();
  const isGone = (agent: AgentRow) => GONE.has(agent.status);
  const isActiveTicket = (ticket: TicketRow) =>
    ACTIVE_TICKETS.has(ticket.status);

  const setAgent: DemoWorld['setAgent'] = (agent, status) => {
    const at = store.now();
    const next = store.patch('agents', agent.id, {
      status,
      updatedAt: at,
      endedAt: (GONE.has(status) && at) || null,
    });
    store.emit(`agent.${status}`, {
      agentId: agent.id,
      payload: { name: agent.name, role: agent.role },
    });
    return next ?? agent;
  };

  const expireCard: DemoWorld['expireCard'] = (card, reason) => {
    const next = store.patch('cards', card.id, {
      status: 'expired',
      expiresAt: store.now(),
    });
    store.emit('card.expired', {
      agentId: card.agentId,
      ticketId: card.ticketId,
      payload: { cardId: card.id, reason },
    });
    return next ?? card;
  };

  const settleCard: DemoWorld['settleCard'] = (card, answer) => {
    const status = (answer === null && 'declined') || 'answered';
    const next = store.patch('cards', card.id, {
      status,
      answer,
      answeredAt: store.now(),
    });
    store.emit(`card.${status}`, {
      agentId: card.agentId,
      ticketId: card.ticketId,
      payload: { cardId: card.id, answer },
    });
    return next ?? card;
  };

  const world: DemoWorld = {
    store,
    turnText,
    isGone,
    isActiveTicket,
    openRound: () =>
      store
        .rows('rounds')
        .filter((round) => round.status !== 'ended')
        .toSorted((a, b) => b.number - a.number)[0],
    livingAgents: (roundId) =>
      store
        .rows('agents')
        .filter((agent) => agent.roundId === roundId && !isGone(agent)),
    startRound: (goal) => {
      const number =
        Math.max(0, ...store.rows('rounds').map((round) => round.number)) + 1;
      const round: RoundRow = {
        id: store.newId(),
        projectId: store.projectId,
        number,
        status: 'planning',
        goal,
        startedAt: store.now(),
        endedAt: null,
      };
      store.put('rounds', round);
      store.emit('round.started', {
        payload: { roundId: round.id, round: number, goal },
      });
      return round;
    },
    activateRound: (round) => {
      store.patch('rounds', round.id, { status: 'active' });
    },
    endRound: (round, reason) => {
      const crew = store
        .rows('agents')
        .filter((agent) => agent.roundId === round.id);
      const crewIds = new Set(crew.map((agent) => agent.id));
      const open = store
        .rows('cards')
        .filter(
          (card) =>
            card.status === 'open' &&
            card.agentId !== null &&
            crewIds.has(card.agentId),
        );
      open.forEach((card) => expireCard(card, `round ${reason}`));
      const reopened = store
        .rows('tickets')
        .filter((ticket) => ticket.roundId === round.id)
        .filter(isActiveTicket);
      reopened.forEach((ticket) => {
        store.patch('tickets', ticket.id, {
          status: 'open',
          assigneeId: null,
          updatedAt: store.now(),
        });
        store.emit('ticket.reopened', {
          ticketId: ticket.id,
          agentId: ticket.assigneeId,
          payload: {
            roundId: round.id,
            previousStatus: ticket.status,
            previousAssigneeId: ticket.assigneeId,
          },
        });
      });
      const retired = crew.filter((agent) => !isGone(agent));
      retired.forEach((agent) => setAgent(agent, 'retired'));
      store.patch('rounds', round.id, {
        status: 'ended',
        endedAt: store.now(),
      });
      store.emit('round.ended', {
        payload: {
          roundId: round.id,
          round: round.number,
          closedCards: open.length,
          retired: retired.length,
          reason,
          reopened: reopened.length,
        },
      });
    },
    birth: (name, role, roundId, runtime = 'kiro') => {
      const at = store.now();
      const agent: AgentRow = {
        id: store.newId(),
        projectId: store.projectId,
        roundId,
        name,
        role,
        runtime,
        status: 'idle',
        sessionId: `demo-session-${name}`,
        worktreePath:
          (role === 'builder' && `${DEMO_WORKTREES}/${name}`) || null,
        createdAt: at,
        updatedAt: at,
        endedAt: null,
      };
      store.put('agents', agent);
      store.emit('agent.born', {
        agentId: agent.id,
        payload: { name, role, runtime },
      });
      return agent;
    },
    setAgent,
    createTicket: (title, body, status, roundId) => {
      const at = store.now();
      const ticket: TicketRow = {
        id: store.newId(),
        projectId: store.projectId,
        roundId,
        assigneeId: null,
        title,
        body,
        status,
        dependsOn: [],
        source: 'local',
        externalId: null,
        prUrl: null,
        headSha: null,
        createdAt: at,
        updatedAt: at,
      };
      store.put('tickets', ticket);
      return ticket;
    },
    moveTicket: (ticket, status, fields = {}) => {
      const next =
        store.patch('tickets', ticket.id, {
          ...fields,
          status,
          updatedAt: store.now(),
        }) ?? ticket;
      store.emit(`ticket.${status}`, {
        ticketId: ticket.id,
        agentId: next.assigneeId,
        payload: { title: next.title },
      });
      return next;
    },
    turn: (agent, ticket, tokens, text) => {
      const turns = store.rows('turns');
      const seq =
        Math.max(
          0,
          ...turns
            .filter((turn) => turn.agentId === agent.id)
            .map((turn) => turn.seq),
        ) + 1;
      const endedAt = store.now();
      const row: TurnRow = {
        id: Math.max(0, ...turns.map((turn) => turn.id)) + 1,
        agentId: agent.id,
        ticketId: ticket?.id ?? null,
        seq,
        stopReason: 'end_turn',
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        transcriptPath: `${DEMO_TURNS_DIR}/${agent.name}-${seq}.jsonl`,
        startedAt: new Date(
          Date.parse(endedAt) - TURN_SECONDS * MS_PER_SECOND,
        ).toISOString(),
        endedAt,
      };
      turnText.set(row.id, text);
      store.put('turns', row);
      store.emit('turn.ended', {
        agentId: agent.id,
        ticketId: row.ticketId,
        payload: {
          seq,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
        },
      });
      return row;
    },
    ask: (agent, ticket, question, options, recommendation) => {
      const card: CardRow = {
        id: store.newId(),
        projectId: store.projectId,
        agentId: agent.id,
        ticketId: ticket?.id ?? null,
        kind: 'ask',
        question,
        options,
        checked: null,
        recommendation,
        status: 'open',
        answer: null,
        createdAt: store.now(),
        answeredAt: null,
        expiresAt: null,
      };
      store.put('cards', card);
      store.emit('card.opened', {
        agentId: agent.id,
        ticketId: card.ticketId,
        payload: { cardId: card.id, question },
      });
      return card;
    },
    settleCard,
    expireCard,
  };
  return world;
};
