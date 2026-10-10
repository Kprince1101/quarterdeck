import type { JSX } from 'react';
import { RequestError } from '../widgets/RequestError.js';
import { stepNumber } from './setup-model.js';
import { SetupStep } from './SetupParts.js';
import type { SetupSaveView } from './use-setup-save.js';

export const GO_HELP =
  'Quarterdeck saves the workspace, a project for each repository, the runtime and the profile, then opens the board with the Planner ready. It writes:';

export const SIGNED_OUT_NOTE =
  'Not everything is signed in yet. You can go on: the dashboard asks again when an agent needs it.';

export const GO_LABEL = 'Go to the board';

export interface GoStepProps {
  view: SetupSaveView;
  writes: readonly string[];
  showsSignedOutNote: boolean;
}

export const GoStep = ({
  view,
  writes,
  showsSignedOutNote,
}: GoStepProps): JSX.Element => (
  <SetupStep number={stepNumber('go')} title="Go" help={GO_HELP}>
    <ul className="qd-setup-files" aria-label="Files Go writes">
      {writes.map((file) => (
        <li key={file}>{file}</li>
      ))}
    </ul>
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
