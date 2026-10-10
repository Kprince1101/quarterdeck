import type { JSX } from 'react';
import type { CardView, SignInView } from './card-deck.js';
import { useCardReply } from './use-card-reply.js';

export const CANCEL_SIGN_IN_LABEL = 'Cancel sign-in';

interface SignInProgressProps {
  signIn: SignInView;
}

export const SignInProgress = ({
  signIn,
}: SignInProgressProps): JSX.Element => (
  <div
    className="qd-card-signin"
    data-signin-status={signIn.status}
    role="status"
    aria-live="polite"
  >
    <p className="qd-card-signin-status">{signIn.statusLabel}</p>
    {signIn.code !== null && (
      <p className="qd-card-signin-code">
        Code: <code>{signIn.code}</code>
      </p>
    )}
    {signIn.url !== null && (
      <p className="qd-card-signin-url">
        <a href={signIn.url} target="_blank" rel="noreferrer noopener">
          {signIn.url}
        </a>
      </p>
    )}
  </div>
);

interface SignInCancelProps {
  card: CardView;
}

export const SignInCancel = ({ card }: SignInCancelProps): JSX.Element => {
  const view = useCardReply(card);
  return (
    <div className="qd-card-reply">
      <div className="qd-card-actions">
        <button
          type="button"
          className="qd-card-decline"
          disabled={view.isBusy}
          onClick={view.handleDecline}
        >
          {CANCEL_SIGN_IN_LABEL}
        </button>
      </div>
      {view.hasError && (
        <p className="qd-card-error" role="alert">
          {view.error}
        </p>
      )}
    </div>
  );
};
