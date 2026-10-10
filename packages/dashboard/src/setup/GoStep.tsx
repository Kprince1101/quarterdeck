import type { JSX } from 'react';
import { RequestError } from '../widgets/RequestError.js';
import { SetupStep } from './SetupParts.js';
import type { SetupSaveView } from './use-setup-save.js';

export const GO_HELP =
  'Quarterdeck saves the workspace, a project for each repository and the runtime, then opens the board with the Planner ready.';

export const SIGNED_OUT_NOTE =
  'Not everything is signed in yet. You can go on: the dashboard asks again when an agent needs it.';

export const GO_LABEL = 'Go to the board';

export interface GoStepProps {
  view: SetupSaveView;
  showsSignedOutNote: boolean;
}

export const GoStep = ({
  view,
  showsSignedOutNote,
}: GoStepProps): JSX.Element => (
  <SetupStep number={4} title="Go" help={GO_HELP}>
    {showsSignedOutNote && <p className="qd-setup-note">{SIGNED_OUT_NOTE}</p>}
    <button
      type="button"
      className="qd-setup-go"
      disabled={!view.canGo}
      onClick={view.handleGo}
    >
      {GO_LABEL}
    </button>
    <RequestError error={view.error} />
  </SetupStep>
);
