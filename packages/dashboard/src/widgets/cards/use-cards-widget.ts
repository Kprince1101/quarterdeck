import { useId, useMemo, useState } from 'react';
import { useDeck } from '../../deck/deck.js';
import { useNow } from '../events/use-now.js';
import { cardDeck, type CardDeck } from './card-deck.js';

export interface CardsWidgetView extends CardDeck {
  hasOpen: boolean;
  hasHistory: boolean;
  showHistory: boolean;
  historyId: string;
  historyControls: string | undefined;
  historyLabel: string;
  handleToggleHistory: () => void;
}

export const useCardsWidget = (): CardsWidgetView => {
  const { tables } = useDeck().stream;
  const now = useNow();
  const historyId = useId();
  const [showHistory, setShowHistory] = useState(false);
  const deck = useMemo(
    () =>
      cardDeck({
        cards: tables.cards,
        projects: tables.projects,
        agents: tables.agents,
        tickets: tables.tickets,
        now,
      }),
    [tables.cards, tables.projects, tables.agents, tables.tickets, now],
  );
  let historyControls: string | undefined;
  if (showHistory) historyControls = historyId;
  return {
    ...deck,
    hasOpen: deck.open.length > 0,
    hasHistory: deck.answered.length > 0,
    showHistory,
    historyId,
    historyControls,
    historyLabel: `Answered (${deck.answered.length})`,
    handleToggleHistory: () => {
      setShowHistory((shown) => !shown);
    },
  };
};
