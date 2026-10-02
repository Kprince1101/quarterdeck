export class RoundNotFoundError extends Error {
  readonly roundId: string;

  constructor(roundId: string) {
    super(`No round ${roundId} in this project`);
    this.name = 'RoundNotFoundError';
    this.roundId = roundId;
  }
}

export class RoundEndedError extends Error {
  readonly roundId: string;

  constructor(roundId: string, number: number) {
    super(`Round ${number} has ended; a Driver session cannot start in it`);
    this.name = 'RoundEndedError';
    this.roundId = roundId;
  }
}

export class TicketNotAssignableError extends Error {
  readonly ticketId: string;

  constructor(ticketId: string, reason: string) {
    super(`Ticket ${ticketId} cannot be assigned: ${reason}`);
    this.name = 'TicketNotAssignableError';
    this.ticketId = ticketId;
  }
}

export class BuilderNotAvailableError extends Error {
  readonly agentId: string;

  constructor(agentId: string, reason: string) {
    super(`Agent ${agentId} cannot take a prompt: ${reason}`);
    this.name = 'BuilderNotAvailableError';
    this.agentId = agentId;
  }
}

export class BuilderSessionLostError extends Error {
  readonly agentId: string;
  readonly sessionId: string;

  constructor(agentId: string, sessionId: string) {
    super(`Agent ${agentId} has no live client for session ${sessionId}`);
    this.name = 'BuilderSessionLostError';
    this.agentId = agentId;
    this.sessionId = sessionId;
  }
}

export class AgentNotRetiredError extends Error {
  readonly agentId: string;

  constructor(agentId: string, status: string) {
    super(
      `Agent ${agentId} is ${status}; its tickets are re-assigned only once it is retired`,
    );
    this.name = 'AgentNotRetiredError';
    this.agentId = agentId;
  }
}

export class NotADriverError extends Error {
  readonly agentId: string;

  constructor(agentId: string, reason: string) {
    super(`Agent ${agentId} cannot drive a round: ${reason}`);
    this.name = 'NotADriverError';
    this.agentId = agentId;
  }
}
