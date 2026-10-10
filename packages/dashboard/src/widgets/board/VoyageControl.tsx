import type { JSX } from 'react';
import { useShowsProjects } from '../../deck/DeckProvider.js';
import { RequestError } from '../RequestError.js';
import {
  useVoyageControl,
  type VoyageControlView,
  type VoyageProjectView,
} from './use-voyage-control.js';

interface ControlProps {
  control: VoyageControlView;
}

const VoyageActions = ({ control }: ControlProps) => (
  <div className="qd-board-actions">
    <button
      type="button"
      className="qd-board-button"
      disabled={control.isPending}
      onClick={control.handleEnd}
    >
      End voyage
    </button>
    <button
      type="button"
      className="qd-board-button qd-board-danger"
      disabled={control.isPending}
      onClick={control.handleKill}
    >
      Kill all
    </button>
  </div>
);

const KillConfirm = ({ control }: ControlProps) => (
  <div className="qd-board-actions">
    <button
      type="button"
      className="qd-board-button qd-board-danger"
      disabled={control.isPending}
      onClick={control.handleConfirmKill}
    >
      {control.killConfirmLabel}
    </button>
    <button
      type="button"
      className="qd-board-button"
      onClick={control.handleCancelKill}
    >
      Cancel
    </button>
  </div>
);

interface ProjectKillProps {
  project: VoyageProjectView;
  isPending: boolean;
}

const ProjectKill = ({ project, isPending }: ProjectKillProps) => (
  <li className="qd-board-voyage-project" data-voyage-project={project.slug}>
    <span>{project.slug}</span>
    <button
      type="button"
      className="qd-board-button qd-board-danger"
      disabled={isPending}
      aria-label={project.killLabel}
      title={project.killLabel}
      onClick={project.handleKill}
    >
      Kill
    </button>
  </li>
);

const OpenVoyage = ({ control }: ControlProps) => {
  const showsProjects = useShowsProjects();
  return (
    <>
      <p className="qd-board-voyage-head">
        <span className="qd-board-voyage-label">{control.voyageLabel}</span>
        <span className="qd-board-voyage-goal">{control.voyageGoal}</span>
      </p>
      {showsProjects && (
        <ul className="qd-board-voyage-projects" aria-label="Voyage projects">
          {control.projects.map((project) => (
            <ProjectKill
              key={project.slug}
              project={project}
              isPending={control.isPending}
            />
          ))}
        </ul>
      )}
      {control.showVoyageActions && <VoyageActions control={control} />}
      {control.isConfirmingKill && <KillConfirm control={control} />}
    </>
  );
};

const NewVoyage = ({ control }: ControlProps) => (
  <>
    <p className="qd-empty">No voyage running.</p>
    <div className="qd-board-actions">
      <input
        className="qd-board-input"
        aria-label="Voyage goal"
        placeholder="Voyage goal"
        value={control.goal}
        onChange={control.handleGoalChange}
      />
      <button
        type="button"
        className="qd-board-button"
        disabled={!control.canStart}
        onClick={control.handleStart}
      >
        Start voyage
      </button>
    </div>
  </>
);

export const VoyageControl = (): JSX.Element => {
  const control = useVoyageControl();
  return (
    <section className="qd-board-voyage" aria-label="Voyage">
      {control.hasVoyage && <OpenVoyage control={control} />}
      {control.noVoyage && <NewVoyage control={control} />}
      <RequestError error={control.error} />
    </section>
  );
};
