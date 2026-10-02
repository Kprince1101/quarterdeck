import { RequestError } from '../request-error.js';
import { NOT_WIRED, type ProjectPanel } from './project-model.js';
import { usePauseControls } from './use-pause-controls.js';

interface UnwiredToggleProps {
  label: string;
}

const UnwiredToggle = ({ label }: UnwiredToggleProps) => (
  <label className="qd-project-toggle" title={NOT_WIRED}>
    <input type="checkbox" disabled />
    <span>{label}</span>
  </label>
);

export interface ProjectTogglesProps {
  panel: ProjectPanel;
}

export const ProjectToggles = ({ panel }: ProjectTogglesProps) => {
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
        <UnwiredToggle label="Copilot" />
        <UnwiredToggle label="Auto-merge" />
      </div>
      <RequestError error={error} />
    </section>
  );
};
