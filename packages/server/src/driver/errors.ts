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

export class NotADriverError extends Error {
  readonly agentId: string;

  constructor(agentId: string, reason: string) {
    super(`Agent ${agentId} cannot drive a round: ${reason}`);
    this.name = 'NotADriverError';
    this.agentId = agentId;
  }
}
