import type { JSX } from 'react';
import { RequestError } from '../widgets/RequestError.js';
import type { MissingRuntime } from './setup-model.js';
import { SetupNote, SetupStep } from './SetupParts.js';
import type { RuntimeChoice, RuntimeStepView } from './use-runtime-step.js';

export const RUNTIME_HELP =
  'The agent CLI your crew runs on. Only the ones installed on this machine are listed.';

export const NO_RUNTIME =
  'No runtime is installed yet. Install one of these, then check again.';

interface RuntimeListProps {
  options: readonly RuntimeChoice[];
  onChange: RuntimeStepView['handleRuntimeChange'];
}

const RuntimeList = ({ options, onChange }: RuntimeListProps): JSX.Element => (
  <ul className="qd-setup-list">
    {options.map((option) => (
      <li key={option.runtime}>
        <label className="qd-setup-choice">
          <input
            type="radio"
            name="runtime"
            value={option.runtime}
            checked={option.isChecked}
            onChange={onChange}
          />
          <span className="qd-setup-choice-name">{option.name}</span>
          <span className="qd-setup-choice-detail">{option.state}</span>
        </label>
      </li>
    ))}
  </ul>
);

interface MissingListProps {
  missing: readonly MissingRuntime[];
}

const MissingList = ({ missing }: MissingListProps): JSX.Element => (
  <ul className="qd-setup-missing" aria-label="Not installed">
    {missing.map((runtime) => (
      <li key={runtime.name}>
        <span>{runtime.name} is not installed.</span>
        <SetupNote text={runtime.hint} className="qd-setup-command" />
      </li>
    ))}
  </ul>
);

export interface RuntimeStepProps {
  view: RuntimeStepView;
}

export const RuntimeStep = ({ view }: RuntimeStepProps): JSX.Element => (
  <SetupStep number={2} title="Runtime" help={RUNTIME_HELP}>
    {view.isLoading && (
      <p className="qd-empty">Checking what is installed...</p>
    )}
    <RequestError error={view.error} />
    {view.hasNone && <p className="qd-setup-note">{NO_RUNTIME}</p>}
    <RuntimeList options={view.options} onChange={view.handleRuntimeChange} />
    <MissingList missing={view.missing} />
    <button
      type="button"
      className="qd-setup-quiet"
      disabled={view.isLoading}
      onClick={view.handleRefresh}
    >
      Check again
    </button>
  </SetupStep>
);
