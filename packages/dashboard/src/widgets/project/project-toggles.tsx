import { RequestError } from '../request-error.js';
import type { ProjectPanel } from './project-model.js';
import {
  useMergeGateToggles,
  type GateToggleView,
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

const MergeGateToggles = ({ panel }: PanelProps) => {
  const { toggles, error } = useMergeGateToggles(panel);
  return (
    <>
      <div className="qd-project-actions">
        {toggles.map((toggle) => (
          <GateToggleBox key={toggle.key} toggle={toggle} />
        ))}
      </div>
      <RequestError error={error} />
    </>
  );
};

export const ProjectToggles = ({ panel }: PanelProps) => {
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
