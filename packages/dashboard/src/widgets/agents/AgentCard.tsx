import type { JSX } from 'react';
import { RequestError } from '../RequestError.js';
import type { AgentTicketView, AgentView } from './agents-model.js';
import type { HeldWorkView } from './held-work.js';
import { useAgentCard, type AgentActionView } from './use-agent-card.js';

interface AgentTicketsProps {
  tickets: AgentTicketView[];
}

const AgentTickets = ({ tickets }: AgentTicketsProps) => (
  <ul className="qd-agent-tickets" aria-label="Tickets">
    {tickets.map((ticket) => (
      <li key={ticket.id} data-ticket-id={ticket.id}>
        <span className="qd-agent-ticket-title">{ticket.title}</span>
        <span className="qd-agent-ticket-status">{ticket.statusLabel}</span>
      </li>
    ))}
  </ul>
);

interface HeldWorkProps {
  held: HeldWorkView[];
}

const HeldWork = ({ held }: HeldWorkProps) => (
  <ul className="qd-agent-held" aria-label="Held work">
    {held.map((work) => (
      <li key={work.eventId} data-held-event-id={work.eventId}>
        {work.text}
      </li>
    ))}
  </ul>
);

interface AgentActionsProps {
  actions: AgentActionView[];
  isBusy: boolean;
}

const AgentActions = ({ actions, isBusy }: AgentActionsProps) => (
  <div className="qd-agent-actions">
    {actions.map((action) => (
      <button
        key={action.kind}
        type="button"
        data-action={action.kind}
        disabled={isBusy}
        onClick={action.onClick}
      >
        {action.label}
      </button>
    ))}
  </div>
);

export interface AgentCardProps {
  agent: AgentView;
  showProject: boolean;
}

export const AgentCard = ({
  agent,
  showProject,
}: AgentCardProps): JSX.Element => {
  const card = useAgentCard(agent);
  return (
    <li
      className="qd-agent"
      aria-label={agent.name}
      data-agent-id={agent.id}
      data-status={agent.status}
      data-killing={card.isKilling}
    >
      <div className="qd-agent-head">
        <span className="qd-agent-name">{agent.name}</span>
        <span className="qd-agent-role">{agent.role}</span>
        {showProject && (
          <span className="qd-agent-project">{agent.project}</span>
        )}
        <span className="qd-agent-state">{card.stateLabel}</span>
        <time
          className="qd-agent-since"
          dateTime={agent.updatedAt}
          title={`since ${agent.updatedAt}`}
        >
          {agent.since}
        </time>
      </div>
      {agent.hasWork && (
        <p className="qd-agent-work">
          <span className="qd-agent-label">working on</span>{' '}
          <span className="qd-agent-working-on">{agent.workingOn}</span>
        </p>
      )}
      {agent.hasWork && <AgentTickets tickets={agent.tickets} />}
      {agent.hasHeld && <HeldWork held={agent.held} />}
      <RequestError error={card.error} />
      <AgentActions actions={card.actions} isBusy={card.isBusy} />
    </li>
  );
};
