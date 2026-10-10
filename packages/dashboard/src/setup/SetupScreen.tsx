import type { JSX } from 'react';
import { GoStep } from './GoStep.js';
import { ProfileStep } from './ProfileStep.js';
import { RuntimeStep } from './RuntimeStep.js';
import { SetupProgress } from './SetupParts.js';
import { SignInStep } from './SignInStep.js';
import { useSetupScreen, type SetupSources } from './use-setup-screen.js';
import { WorkspaceStep } from './WorkspaceStep.js';
import './setup.css';

export interface SetupScreenProps {
  sources: SetupSources;
  onDone: () => void;
}

export const SetupScreen = ({
  sources,
  onDone,
}: SetupScreenProps): JSX.Element => {
  const view = useSetupScreen(sources, onDone);
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
        <ProfileStep view={view.profile} />
        <SignInStep view={view.signIn} />
        <GoStep
          view={view.go}
          writes={view.writes}
          showsSignedOutNote={view.showsSignedOutNote}
        />
      </main>
    </div>
  );
};
