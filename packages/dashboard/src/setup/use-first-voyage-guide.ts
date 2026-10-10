import { useDeck } from '../deck/DeckProvider.js';

export interface FirstVoyageGuideView {
  isShown: boolean;
}

export const useFirstVoyageGuide = (): FirstVoyageGuideView => {
  const { stream } = useDeck();
  return {
    isShown: stream.status === 'live' && stream.tables.voyages.length === 0,
  };
};
