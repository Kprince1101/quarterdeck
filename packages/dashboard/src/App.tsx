import type { JSX } from 'react';
import { DeckProvider, type DeckSources } from './deck/DeckProvider.js';
import { DeckLayout } from './layouts/DeckLayout.js';
import { Shell } from './shell/Shell.js';

export interface AppProps extends DeckSources {
  mode?: string | undefined;
}

export const App = ({ mode, ...sources }: AppProps): JSX.Element => (
  <DeckProvider {...sources}>
    <Shell mode={mode}>
      <DeckLayout />
    </Shell>
  </DeckProvider>
);
