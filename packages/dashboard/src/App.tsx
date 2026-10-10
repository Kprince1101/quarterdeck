import type { JSX } from 'react';
import { DeckProvider, type DeckSources } from './deck/DeckProvider.js';
import { DeckLayout } from './layouts/DeckLayout.js';
import { FirstVoyageGuide } from './setup/FirstVoyageGuide.js';
import { SetupScreen } from './setup/SetupScreen.js';
import { useSetupGate } from './setup/use-setup-gate.js';
import { Shell } from './shell/Shell.js';

export interface AppProps extends DeckSources {
  mode?: string | undefined;
}

export const App = ({ mode, ...sources }: AppProps): JSX.Element => {
  const gate = useSetupGate(sources);
  if (gate.showsSetup) {
    return <SetupScreen sources={gate.sources} onDone={gate.handleDone} />;
  }
  return (
    <DeckProvider {...sources}>
      <Shell mode={mode}>
        <DeckLayout />
        <FirstVoyageGuide />
      </Shell>
    </DeckProvider>
  );
};
