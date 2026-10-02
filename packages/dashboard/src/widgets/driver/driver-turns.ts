import type {
  AgentRow,
  RoundRow,
  SnapshotTables,
  TurnRow,
} from '@quarterdeck/server/stream-schema';

export interface DriverTurn {
  turn: TurnRow;
  driver: AgentRow;
}

const WHOLE_NUMBER = /^[1-9]\d*$/;

export const parseThrough = (text: string, last: number): number | null => {
  const trimmed = text.trim();
  if (!WHOLE_NUMBER.test(trimmed)) return null;
  const through = Number(trimmed);
  if (through > last) return null;
  return through;
};

export const roundsNewestFirst = (rounds: readonly RoundRow[]): RoundRow[] =>
  rounds.toSorted((a, b) => b.number - a.number);

export const currentRound = (
  rounds: readonly RoundRow[],
): RoundRow | undefined => {
  const newest = roundsNewestFirst(rounds);
  return newest.find((round) => round.status === 'active') ?? newest[0];
};

export const roundTurns = (
  tables: Pick<SnapshotTables, 'agents' | 'turns'>,
  roundId: string | undefined,
): DriverTurn[] => {
  if (roundId === undefined) return [];
  const drivers = new Map(
    tables.agents
      .filter((agent) => agent.role === 'driver' && agent.roundId === roundId)
      .map((agent) => [agent.id, agent]),
  );
  return tables.turns
    .flatMap((turn) => {
      const driver = drivers.get(turn.agentId);
      if (driver === undefined) return [];
      return [{ turn, driver }];
    })
    .toSorted((a, b) => b.turn.id - a.turn.id);
};
