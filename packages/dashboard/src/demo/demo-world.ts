import type {
  AgentRow,
  CardRow,
  VoyageRow,
  TicketRow,
  TurnRow,
} from '@quarterdeck/server/stream-schema';
import { DEMO_PROJECT } from './demo-seed.js';
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
  'blocked',
]);

const BLOCKED_ON_KILL: ReadonlySet<TicketStatus> = new Set([
  'assigned',
  'in_progress',
]);

const RUNNING: ReadonlySet<AgentStatus> = new Set([
  'starting',
  'working',
  'stuck',
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
  openVoyage: () => VoyageRow | undefined;
  livingAgents: (voyageId: string) => AgentRow[];
  startVoyage: (goal: string) => VoyageRow;
  activateVoyage: (voyage: VoyageRow) => void;
  endVoyage: (voyage: VoyageRow, reason: 'ended' | 'killed') => void;
  birth: (
    name: string,
    role: AgentRole,
    voyageId: string | null,
    runtime?: AgentRow['runtime'],
  ) => AgentRow;
  setAgent: (agent: AgentRow, status: AgentStatus) => AgentRow;
  killAgent: (agent: AgentRow) => AgentRow;
  resetAgent: (agent: AgentRow) => AgentRow;
  retireArchived: () => string[];
  createTicket: (
    title: string,
    body: string,
    status: TicketStatus,
    voyageId: string | null,
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
  settleCard: (
    card: CardRow,
    answer: string | null,
    attachments?: CardRow['attachments'],
  ) => CardRow;
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

  const killAgent: DemoWorld['killAgent'] = (agent) => {
    const killed = setAgent(agent, 'killed');
    store
      .rows('tickets')
      .filter(
        (ticket) =>
          ticket.assigneeId === agent.id && BLOCKED_ON_KILL.has(ticket.status),
      )
      .forEach((ticket) => {
        store.patch('tickets', ticket.id, {
          status: 'blocked',
          updatedAt: store.now(),
        });
        store.emit('ticket.blocked', {
          agentId: agent.id,
          ticketId: ticket.id,
          payload: {
            name: agent.name,
            previousStatus: ticket.status,
            reason: 'killed',
          },
        });
      });
    return killed;
  };

  const resetAgent: DemoWorld['resetAgent'] = (agent) => {
    let status = agent.status;
    if (RUNNING.has(status)) status = 'idle';
    const reset =
      store.patch('agents', agent.id, {
        status,
        sessionId: null,
        updatedAt: store.now(),
      }) ?? agent;
    store.emit('agent.session_reset', {
      agentId: agent.id,
      payload: { name: agent.name, sessionId: agent.sessionId },
    });
    return reset;
  };

  const retireArchived: DemoWorld['retireArchived'] = () => {
    const retired = store
      .rows('agents')
      .filter((agent) => agent.status !== 'retired')
      .map((agent) => setAgent(agent, 'retired').id);
    if (retired.length > 0) {
      store.emit('archive.retired', { payload: { retired, discardCards: [] } });
    }
    return retired;
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

  const settleCard: DemoWorld['settleCard'] = (
    card,
    answer,
    attachments = [],
  ) => {
    const status = (answer === null && 'declined') || 'answered';
    const next = store.patch('cards', card.id, {
      status,
      answer,
      attachments,
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
    openVoyage: () =>
      store
        .rows('voyages')
        .filter((voyage) => voyage.status !== 'ended')
        .toSorted((a, b) => b.number - a.number)[0],
    livingAgents: (voyageId) =>
      store
        .rows('agents')
        .filter((agent) => agent.voyageId === voyageId && !isGone(agent)),
    startVoyage: (goal) => {
      const number =
        Math.max(0, ...store.rows('voyages').map((voyage) => voyage.number)) +
        1;
      const voyage: VoyageRow = {
        id: store.newId(),
        projectId: store.projectId,
        number,
        status: 'planning',
        goal,
        projects: [DEMO_PROJECT],
        startedAt: store.now(),
        endedAt: null,
      };
      store.put('voyages', voyage);
      store.emit('voyage.started', {
        payload: { voyageId: voyage.id, voyage: number, goal },
      });
      return voyage;
    },
    activateVoyage: (voyage) => {
      store.patch('voyages', voyage.id, { status: 'active' });
    },
    endVoyage: (voyage, reason) => {
      const crew = store
        .rows('agents')
        .filter((agent) => agent.voyageId === voyage.id);
      const crewIds = new Set(crew.map((agent) => agent.id));
      const open = store
        .rows('cards')
        .filter(
          (card) =>
            card.status === 'open' &&
            card.agentId !== null &&
            crewIds.has(card.agentId),
        );
      open.forEach((card) => expireCard(card, `voyage ${reason}`));
      const reopened = store
        .rows('tickets')
        .filter((ticket) => ticket.voyageId === voyage.id)
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
            voyageId: voyage.id,
            previousStatus: ticket.status,
            previousAssigneeId: ticket.assigneeId,
          },
        });
      });
      const retired = crew.filter((agent) => !isGone(agent));
      retired.forEach((agent) => setAgent(agent, 'retired'));
      store.patch('voyages', voyage.id, {
        status: 'ended',
        endedAt: store.now(),
      });
      store.emit('voyage.ended', {
        payload: {
          voyageId: voyage.id,
          voyage: voyage.number,
          closedCards: open.length,
          retired: retired.length,
          reason,
          reopened: reopened.length,
        },
      });
    },
    birth: (name, role, voyageId, runtime = 'kiro') => {
      const at = store.now();
      const agent: AgentRow = {
        id: store.newId(),
        projectId: store.projectId,
        voyageId,
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
    createTicket: (title, body, status, voyageId) => {
      const at = store.now();
      const ticket: TicketRow = {
        id: store.newId(),
        projectId: store.projectId,
        voyageId,
        assigneeId: null,
        title,
        body,
        status,
        dependsOn: [],
        source: 'local',
        externalId: null,
        externalRef: null,
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
        attachments: [],
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
    killAgent,
    resetAgent,
    retireArchived,
  };
  return world;
};
