import type { JSX } from 'react';
import { RequestError } from '../RequestError.js';
import type { ProjectPanel } from './project-model.js';
import {
  useMergeGateToggles,
  type GateToggleView,
  type MergeGateTogglesView,
} from './use-merge-gate-toggles.js';
import { usePauseControls } from './use-pause-controls.js';

interface GateToggleProps {
  toggle: GateToggleView;
}

const GateToggleBox = ({ toggle }: GateToggleProps) => (
  <label
    className="qd-project-toggle"
    title={toggle.title}
    data-gate={toggle.key}
  >
    <input
      type="checkbox"
      checked={toggle.checked}
      disabled={toggle.isDisabled}
      onChange={toggle.handleChange}
    />
    <span>{toggle.label}</span>
  </label>
);

interface PanelProps {
  panel: ProjectPanel;
}

interface AutoMergeConfirmProps {
  gates: MergeGateTogglesView;
}

const AutoMergeConfirm = ({ gates }: AutoMergeConfirmProps) => (
  <div
    className="qd-project-confirm"
    role="group"
    aria-label="Confirm auto-merge"
  >
    <p className="qd-project-warning">{gates.autoMergeWarning}</p>
    <div className="qd-project-actions">
      <button
        type="button"
        className="qd-project-danger"
        disabled={gates.isConfirmDisabled}
        onClick={gates.handleConfirmAutoMerge}
      >
        Turn on auto-merge
      </button>
      <button type="button" onClick={gates.handleCancelAutoMerge}>
        Cancel
      </button>
    </div>
  </div>
);

const MergeGateToggles = ({ panel }: PanelProps) => {
  const gates = useMergeGateToggles(panel);
  return (
    <>
      <div className="qd-project-actions">
        {gates.toggles.map((toggle) => (
          <GateToggleBox key={toggle.key} toggle={toggle} />
        ))}
      </div>
      {gates.isConfirmingAutoMerge && <AutoMergeConfirm gates={gates} />}
      <RequestError error={gates.error} />
    </>
  );
};

export const ProjectToggles = ({ panel }: PanelProps): JSX.Element => {
  const { isPending, error, handlePause, handleResume } =
    usePauseControls(panel);
  return (
    <section className="qd-project-section" aria-label="Toggles">
      <h3 className="qd-project-heading">Toggles</h3>
      <div className="qd-project-actions">
        <button type="button" disabled={isPending} onClick={handlePause}>
          Pause
        </button>
        <button type="button" disabled={isPending} onClick={handleResume}>
          Resume
        </button>
      </div>
      <RequestError error={error} />
      <MergeGateToggles panel={panel} />
    </section>
  );
};
