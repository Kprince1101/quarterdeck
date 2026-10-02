import { useMemo, useState } from 'react';
import type { RoundRow } from '@quarterdeck/server/stream-schema';
import { useDeck } from '../../deck/DeckProvider.js';
import {
  currentRound,
  roundTurns,
  roundsNewestFirst,
  type DriverTurn,
} from './driver-turns.js';
import { useTurnDetail, type TurnDetail } from './use-turn-detail.js';

export interface DriverWidgetView {
  project: string | null;
  rounds: RoundRow[];
  round: RoundRow | null;
  turns: DriverTurn[];
  selected: DriverTurn | null;
  detail: TurnDetail | null;
  selectRound: (roundId: string) => void;
  selectTurn: (turnId: number) => void;
}

export const useDriverWidget = (): DriverWidgetView => {
  const { stream, intents } = useDeck();
  const { tables } = stream;
  const [roundId, setRoundId] = useState<string | null>(null);
  const [turnId, setTurnId] = useState<number | null>(null);

  const project = tables.projects[0]?.slug ?? null;
  const rounds = useMemo(() => roundsNewestFirst(tables.rounds), [tables]);
  const round =
    rounds.find((candidate) => candidate.id === roundId) ??
    currentRound(rounds) ??
    null;
  const turns = useMemo(() => roundTurns(tables, round?.id), [tables, round]);
  const selected =
    turns.find(({ turn }) => turn.id === turnId) ?? turns[0] ?? null;
  const detail = useTurnDetail(intents, project, selected?.turn ?? null);

  return {
    project,
    rounds,
    round,
    turns,
    selected,
    detail,
    selectRound: (id) => {
      setRoundId(id);
      setTurnId(null);
    },
    selectTurn: setTurnId,
  };
};
