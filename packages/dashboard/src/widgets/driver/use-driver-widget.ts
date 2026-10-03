import { useMemo, useState } from 'react';
import type { VoyageRow } from '@quarterdeck/server/stream-schema';
import { useDeck } from '../../deck/DeckProvider.js';
import {
  currentVoyage,
  voyageTurns,
  voyagesNewestFirst,
  type DriverTurn,
} from './driver-turns.js';
import { useTurnDetail, type TurnDetail } from './use-turn-detail.js';

export interface DriverWidgetView {
  project: string | null;
  voyages: VoyageRow[];
  voyage: VoyageRow | null;
  turns: DriverTurn[];
  selected: DriverTurn | null;
  detail: TurnDetail | null;
  selectVoyage: (voyageId: string) => void;
  selectTurn: (turnId: number) => void;
}

export const useDriverWidget = (): DriverWidgetView => {
  const { stream, intents } = useDeck();
  const { tables } = stream;
  const [voyageId, setVoyageId] = useState<string | null>(null);
  const [turnId, setTurnId] = useState<number | null>(null);

  const project = tables.projects[0]?.slug ?? null;
  const voyages = useMemo(() => voyagesNewestFirst(tables.voyages), [tables]);
  const voyage =
    voyages.find((candidate) => candidate.id === voyageId) ??
    currentVoyage(voyages) ??
    null;
  const turns = useMemo(
    () => voyageTurns(tables, voyage?.id),
    [tables, voyage],
  );
  const selected =
    turns.find(({ turn }) => turn.id === turnId) ?? turns[0] ?? null;
  const detail = useTurnDetail(intents, project, selected?.turn ?? null);

  return {
    project,
    voyages,
    voyage,
    turns,
    selected,
    detail,
    selectVoyage: (id) => {
      setVoyageId(id);
      setTurnId(null);
    },
    selectTurn: setTurnId,
  };
};
