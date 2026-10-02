import { DeckProvider, type DeckSources } from './deck/deck.js';
import { DeckLayout } from './layouts/deck-layout.js';
import { Shell } from './shell/shell.js';

export interface AppProps extends DeckSources {
  mode?: string | undefined;
}

export const App = ({ mode, ...sources }: AppProps) => (
  <DeckProvider {...sources}>
    <Shell mode={mode}>
      <DeckLayout />
    </Shell>
  </DeckProvider>
);
