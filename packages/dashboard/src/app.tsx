import { DeckProvider, type DeckSources } from './deck/deck.js';
import { Shell } from './shell/shell.js';
import { WidgetMount } from './widgets/widget-mount.js';

export const App = (sources: DeckSources) => (
  <DeckProvider {...sources}>
    <Shell>
      <WidgetMount />
    </Shell>
  </DeckProvider>
);
