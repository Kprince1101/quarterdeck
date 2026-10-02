import { createContext, useContext, type ReactNode } from 'react';
import {
  useDeckProvider,
  type Deck,
  type DeckSources,
} from './use-deck-provider.js';

export type { Deck, DeckSources } from './use-deck-provider.js';

export interface DeckProviderProps extends DeckSources {
  children?: ReactNode;
}

const DeckContext = createContext<Deck | null>(null);

export const DeckProvider = ({ children, ...sources }: DeckProviderProps) => {
  const deck = useDeckProvider(sources);
  return <DeckContext value={deck}>{children}</DeckContext>;
};

export const useDeck = (): Deck => {
  const deck = useContext(DeckContext);
  if (deck === null) throw new Error('useDeck needs a <DeckProvider>');
  return deck;
};
