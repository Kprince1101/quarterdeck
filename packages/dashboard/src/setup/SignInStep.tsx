import type { JSX } from 'react';
import { RequestError } from '../widgets/RequestError.js';
import { stepNumber } from './setup-model.js';
import { SetupNote, SetupStep, SignInProgressOf } from './SetupParts.js';
import type { SignInRow, SignInStepView } from './use-sign-in-step.js';

export const SIGN_IN_HELP =
  'Each tool signs in through its own browser sign-in. Quarterdeck never sees a password or a key.';

export const NO_SIGN_IN = 'Pick a runtime first.';

interface SignInItemProps {
  row: SignInRow;
}

const SignInItem = ({ row }: SignInItemProps): JSX.Element => (
  <li className="qd-setup-signin" data-signed-in={row.isSignedIn}>
    <div className="qd-setup-row">
      <span className="qd-setup-choice-name">{row.name}</span>
      <span className="qd-setup-choice-detail">{row.state}</span>
      {row.canSignIn && (
        <button type="button" onClick={row.handleSignIn}>
          Sign in to {row.name}
        </button>
      )}
    </div>
    {!row.isSignedIn && (
      <SetupNote text={row.hint} className="qd-setup-command" />
    )}
    <SignInProgressOf progress={row.progress} />
  </li>
);

export interface SignInStepProps {
  view: SignInStepView;
}

export const SignInStep = ({ view }: SignInStepProps): JSX.Element => (
  <SetupStep number={stepNumber('sign-in')} title="Sign in" help={SIGN_IN_HELP}>
    {!view.hasRows && <p className="qd-empty">{NO_SIGN_IN}</p>}
    <ul className="qd-setup-list">
      {view.rows.map((row) => (
        <SignInItem key={row.key} row={row} />
      ))}
    </ul>
    <RequestError error={view.error} />
  </SetupStep>
);
