import type {
  AgentRow,
  VoyageRow,
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

export const voyagesNewestFirst = (
  voyages: readonly VoyageRow[],
): VoyageRow[] => voyages.toSorted((a, b) => b.number - a.number);

export const currentVoyage = (
  voyages: readonly VoyageRow[],
): VoyageRow | undefined => {
  const newest = voyagesNewestFirst(voyages);
  return newest.find((voyage) => voyage.status === 'active') ?? newest[0];
};

export const voyageTurns = (
  tables: Pick<SnapshotTables, 'agents' | 'turns'>,
  voyageId: string | undefined,
): DriverTurn[] => {
  if (voyageId === undefined) return [];
  const drivers = new Map(
    tables.agents
      .filter((agent) => agent.role === 'driver' && agent.voyageId === voyageId)
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
