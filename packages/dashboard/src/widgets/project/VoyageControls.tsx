import type { JSX } from 'react';
import { RequestError } from '../RequestError.js';
import type { ProjectPanel } from './project-model.js';
import {
  useVoyageControls,
  type VoyageControlsView,
} from './use-voyage-controls.js';

interface VoyageViewProps {
  controls: VoyageControlsView;
}

const VoyageActions = ({ controls }: VoyageViewProps) => (
  <div className="qd-project-actions">
    <button
      type="button"
      disabled={controls.isPending}
      onClick={controls.handleEnd}
    >
      End voyage
    </button>
    <button
      type="button"
      className="qd-project-danger"
      disabled={controls.isPending}
      onClick={controls.handleKill}
    >
      Kill voyage
    </button>
  </div>
);

const KillConfirm = ({ controls }: VoyageViewProps) => (
  <div className="qd-project-actions">
    <button
      type="button"
      className="qd-project-danger"
      disabled={controls.isPending}
      onClick={controls.handleConfirmKill}
    >
      {controls.killConfirmLabel}
    </button>
    <button type="button" onClick={controls.handleCancelKill}>
      Cancel
    </button>
  </div>
);

const OpenVoyage = ({ controls }: VoyageViewProps) => (
  <>
    <p className="qd-project-voyage">
      <span className="qd-project-voyage-label">{controls.voyageLabel}</span>
      <span className="qd-project-goal">{controls.voyageGoal}</span>
    </p>
    {controls.showVoyageActions && <VoyageActions controls={controls} />}
    {controls.isConfirmingKill && <KillConfirm controls={controls} />}
  </>
);

const NewVoyage = ({ controls }: VoyageViewProps) => (
  <>
    <p className="qd-empty">No voyage running.</p>
    <div className="qd-project-actions">
      <input
        className="qd-project-input"
        aria-label="Voyage goal"
        placeholder="Voyage goal"
        value={controls.goal}
        onChange={controls.handleGoalChange}
      />
      <button
        type="button"
        disabled={!controls.canStart}
        onClick={controls.handleStart}
      >
        Start voyage
      </button>
    </div>
  </>
);

export interface VoyageControlsProps {
  panel: ProjectPanel;
}

export const VoyageControls = ({ panel }: VoyageControlsProps): JSX.Element => {
  const controls = useVoyageControls(panel);
  return (
    <section className="qd-project-section" aria-label="Voyage">
      <h3 className="qd-project-heading">Voyage</h3>
      {controls.hasVoyage && <OpenVoyage controls={controls} />}
      {controls.noVoyage && <NewVoyage controls={controls} />}
      <RequestError error={controls.error} />
    </section>
  );
};
