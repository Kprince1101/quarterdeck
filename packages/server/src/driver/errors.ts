import type { Runtime } from '@quarterdeck/rules';
import type { SignInCommand } from '../signin/commands.js';

export class VoyageNotFoundError extends Error {
  readonly voyageId: string;

  constructor(voyageId: string) {
    super(`No voyage ${voyageId} in this project`);
    this.name = 'VoyageNotFoundError';
    this.voyageId = voyageId;
  }
}

export class VoyageEndedError extends Error {
  readonly voyageId: string;

  constructor(voyageId: string, number: number) {
    super(`Voyage ${number} has ended; a Driver session cannot start in it`);
    this.name = 'VoyageEndedError';
    this.voyageId = voyageId;
  }
}

export class TurnInputMissingError extends Error {
  readonly agentId: string;
  readonly seq: number;
  readonly path: string;

  constructor(agentId: string, seq: number, path: string) {
    super(`Agent ${agentId} has no saved input for turn ${seq} (${path})`);
    this.name = 'TurnInputMissingError';
    this.agentId = agentId;
    this.seq = seq;
    this.path = path;
  }
}

export class ReplaySignInError extends Error {
  readonly runtime: Runtime;
  readonly command: string;

  constructor(signIn: SignInCommand, cause: unknown) {
    super(
      `${signIn.displayName} is not signed in; run \`${signIn.command}\` to sign in, then replay again`,
      { cause },
    );
    this.name = 'ReplaySignInError';
    this.runtime = signIn.runtime;
    this.command = signIn.command;
  }
}

export class NoBirthTurnError extends Error {
  readonly agentId: string;
  readonly through: number;

  constructor(agentId: string, through: number) {
    super(
      `Agent ${agentId} has no saved Driver birth input at or before turn ${through}`,
    );
    this.name = 'NoBirthTurnError';
    this.agentId = agentId;
    this.through = through;
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
    super(`Agent ${agentId} cannot drive a voyage: ${reason}`);
    this.name = 'NotADriverError';
    this.agentId = agentId;
  }
}
