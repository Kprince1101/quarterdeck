import type { JSX } from 'react';
import type { IntentClient } from '../api/index.js';
import { GoStep } from './GoStep.js';
import { RuntimeStep } from './RuntimeStep.js';
import { SetupProgress } from './SetupParts.js';
import { SignInStep } from './SignInStep.js';
import { useSetupScreen } from './use-setup-screen.js';
import { WorkspaceStep } from './WorkspaceStep.js';
import './setup.css';

export interface SetupScreenProps {
  intents: IntentClient;
  onDone: () => void;
}

export const SetupScreen = ({
  intents,
  onDone,
}: SetupScreenProps): JSX.Element => {
  const view = useSetupScreen(intents, onDone);
  return (
    <div className="qd-setup">
      <header className="qd-header">
        <h1 className="qd-brand">Quarterdeck</h1>
        <span className="qd-setup-title">Setup</span>
      </header>
      <main className="qd-setup-body">
        <SetupProgress progress={view.progress} steps={view.steps} />
        <WorkspaceStep view={view.workspace} />
        <RuntimeStep view={view.runtime} />
        <SignInStep view={view.signIn} />
        <GoStep view={view.go} showsSignedOutNote={view.showsSignedOutNote} />
      </main>
    </div>
  );
};
