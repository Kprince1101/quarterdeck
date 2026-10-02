import { RequestError } from '../request-error.js';
import type { ProjectPanel } from './project-model.js';
import {
  useRoundControls,
  type RoundControlsView,
} from './use-round-controls.js';

interface RoundViewProps {
  controls: RoundControlsView;
}

const RoundActions = ({ controls }: RoundViewProps) => (
  <div className="qd-project-actions">
    <button
      type="button"
      disabled={controls.isPending}
      onClick={controls.handleEnd}
    >
      End round
    </button>
    <button
      type="button"
      className="qd-project-danger"
      disabled={controls.isPending}
      onClick={controls.handleKill}
    >
      Kill round
    </button>
  </div>
);

const KillConfirm = ({ controls }: RoundViewProps) => (
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

const OpenRound = ({ controls }: RoundViewProps) => (
  <>
    <p className="qd-project-round">
      <span className="qd-project-round-label">{controls.roundLabel}</span>
      <span className="qd-project-goal">{controls.roundGoal}</span>
    </p>
    {controls.showRoundActions && <RoundActions controls={controls} />}
    {controls.isConfirmingKill && <KillConfirm controls={controls} />}
  </>
);

const NewRound = ({ controls }: RoundViewProps) => (
  <>
    <p className="qd-empty">No round running.</p>
    <div className="qd-project-actions">
      <input
        className="qd-project-input"
        aria-label="Round goal"
        placeholder="Round goal"
        value={controls.goal}
        onChange={controls.handleGoalChange}
      />
      <button
        type="button"
        disabled={!controls.canStart}
        onClick={controls.handleStart}
      >
        Start round
      </button>
    </div>
  </>
);

export interface RoundControlsProps {
  panel: ProjectPanel;
}

export const RoundControls = ({ panel }: RoundControlsProps) => {
  const controls = useRoundControls(panel);
  return (
    <section className="qd-project-section" aria-label="Round">
      <h3 className="qd-project-heading">Round</h3>
      {controls.hasRound && <OpenRound controls={controls} />}
      {controls.noRound && <NewRound controls={controls} />}
      <RequestError error={controls.error} />
    </section>
  );
};
