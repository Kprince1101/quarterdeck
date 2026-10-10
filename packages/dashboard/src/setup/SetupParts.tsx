import type { JSX, ReactNode } from 'react';
import { SignInProgress } from '../widgets/cards/SignInParts.js';
import type { SignInView } from '../widgets/cards/card-deck.js';
import type { StepMark } from './setup-model.js';

export interface SetupNoteProps {
  text: string | null;
  className?: string;
}

export const SetupNote = ({
  text,
  className = 'qd-setup-note',
}: SetupNoteProps): JSX.Element | null => {
  if (text === null) return null;
  return <p className={className}>{text}</p>;
};

export interface SetupStepProps {
  number: number;
  title: string;
  help: string;
  children?: ReactNode;
}

export const SetupStep = ({
  number,
  title,
  help,
  children,
}: SetupStepProps): JSX.Element => (
  <section className="qd-setup-step" aria-label={title}>
    <h2 className="qd-setup-step-title">
      {number}. {title}
    </h2>
    <p className="qd-setup-help">{help}</p>
    {children}
  </section>
);

export interface SetupProgressProps {
  progress: string;
  steps: readonly StepMark[];
}

export const SetupProgress = ({
  progress,
  steps,
}: SetupProgressProps): JSX.Element => (
  <div className="qd-setup-progress" role="status" aria-live="polite">
    <span className="qd-setup-progress-line">{progress}</span>
    <ol className="qd-setup-marks">
      {steps.map((step) => (
        <li key={step.id} data-done={step.isDone}>
          {step.label}
        </li>
      ))}
    </ol>
  </div>
);

export interface SignInProgressOfProps {
  progress: SignInView | null;
}

export const SignInProgressOf = ({
  progress,
}: SignInProgressOfProps): JSX.Element | null => {
  if (progress === null) return null;
  return <SignInProgress signIn={progress} />;
};
