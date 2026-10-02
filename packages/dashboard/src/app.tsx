import { DeckProvider, type DeckSources } from './deck/deck.js';
import { DeckLayout } from './layouts/deck-layout.js';
import { Shell } from './shell/shell.js';

export const App = (sources: DeckSources) => (
  <DeckProvider {...sources}>
    <Shell>
      <DeckLayout />
    </Shell>
  </DeckProvider>
);
