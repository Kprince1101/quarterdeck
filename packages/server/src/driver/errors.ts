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

export class NotADriverError extends Error {
  readonly agentId: string;

  constructor(agentId: string, reason: string) {
    super(`Agent ${agentId} cannot drive a round: ${reason}`);
    this.name = 'NotADriverError';
    this.agentId = agentId;
  }
}
