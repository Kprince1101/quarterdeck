import { createContext, useContext, type ReactNode, type JSX } from 'react';
import { DEFAULT_WORKSPACE_MODE } from '@quarterdeck/server/workspace-wording';
import type { WorkspaceMode } from '../api/index.js';
import {
  useDeckProvider,
  type Deck,
  type DeckSources,
} from './use-deck-provider.js';
import { wordingFor, type Wording } from './wording.js';

export type { Deck, DeckSources } from './use-deck-provider.js';
export { wordingFor, type Wording } from './wording.js';

export interface DeckProviderProps extends DeckSources {
  children?: ReactNode;
}

const DeckContext = createContext<Deck | null>(null);

export const DeckProvider = ({
  children,
  ...sources
}: DeckProviderProps): JSX.Element => {
  const deck = useDeckProvider(sources);
  return <DeckContext value={deck}>{children}</DeckContext>;
};

export const useDeck = (): Deck => {
  const deck = useContext(DeckContext);
  if (deck === null) throw new Error('useDeck needs a <DeckProvider>');
  return deck;
};

export const useWorkspaceMode = (): WorkspaceMode =>
  useDeck().stream.workspace?.mode ?? DEFAULT_WORKSPACE_MODE;

export const useShowsProjects = (): boolean => useWorkspaceMode() === 'multi';

export const useWording = (): Wording => wordingFor(useWorkspaceMode());
