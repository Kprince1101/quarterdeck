import type { JSX } from 'react';
import type { WorkspaceMode } from '../../api/index.js';
import { useWorkspaceMode, wordingFor } from '../../deck/DeckProvider.js';
import { defineWidget } from '../registry.js';
import type { AgentLiveness, ProjectLiveness } from './board-model.js';
import { useBoardWidget, type StreamLiveness } from './use-board-widget.js';
import type { PauseAllView } from './use-pause-all.js';
import type { ProjectOption, ProjectPickerView } from './use-project-picker.js';
import { VoyageControl } from './VoyageControl.js';
import './board.css';

const PauseControls = ({ pause }: { pause: PauseAllView }) => (
  <div className="qd-board-pause">
    {pause.isPausedEverywhere && (
      <p className="qd-board-paused" title={pause.pausedSince}>
        Paused everywhere
      </p>
    )}
    {pause.showPauseAll && (
      <button
        type="button"
        className="qd-board-button"
        disabled={pause.isPending}
        onClick={pause.handlePauseAll}
      >
        Pause all
      </button>
    )}
    {pause.showResumeAll && (
      <button
        type="button"
        className="qd-board-button"
        disabled={pause.isPending}
        onClick={pause.handleResumeAll}
      >
        Resume all
      </button>
    )}
    <output className="qd-board-outcome" data-tone={pause.outcomeTone}>
      {pause.hasOutcome && pause.outcomeText}
    </output>
  </div>
);

const PickerOption = ({ option }: { option: ProjectOption }) => (
  <li data-project-option={option.id}>
    <label>
      <input
        type="checkbox"
        checked={option.isPicked}
        disabled={option.isDisabled}
        onChange={option.handleToggle}
      />
      <span>{option.name}</span>
      {option.isArchived && <span className="qd-board-tag">archived</span>}
    </label>
  </li>
);

const ProjectPicker = ({ picker }: { picker: ProjectPickerView }) => (
  <fieldset className="qd-board-picker">
    <legend>Projects</legend>
    <p className="qd-board-cap">{picker.capLabel}</p>
    {!picker.hasProjects && <p className="qd-empty">No projects yet.</p>}
    {picker.hasProjects && (
      <ul className="qd-board-options">
        {picker.options.map((option) => (
          <PickerOption key={option.id} option={option} />
        ))}
      </ul>
    )}
    <label className="qd-board-archived">
      <input
        type="checkbox"
        checked={picker.showArchived}
        onChange={picker.handleToggleArchived}
      />
      <span>{picker.archivedLabel}</span>
    </label>
  </fieldset>
);

const AgentChip = ({ agent }: { agent: AgentLiveness }) => (
  <li
    className="qd-board-agent"
    data-agent={agent.id}
    data-status={agent.status}
    aria-label={agent.label}
    title={agent.label}
  >
    <span className="qd-board-agent-name">{agent.name}</span>
    <span className="qd-board-agent-status">{agent.status}</span>
  </li>
);

interface StripProps {
  project: ProjectLiveness;
  isLabelled: boolean;
}

const agentsLabelOf = ({ project, isLabelled }: StripProps): string => {
  if (isLabelled) return project.agentsLabel;
  return 'Agents';
};

const ProjectStrip = ({ project, isLabelled }: StripProps) => (
  <li className="qd-board-project" data-project={project.id}>
    <div className="qd-board-project-head">
      {isLabelled && <h3>{project.name}</h3>}
      {project.inVoyage && <span className="qd-board-tag">voyage</span>}
      {project.isPaused && <span className="qd-board-tag">paused</span>}
      {project.isArchived && <span className="qd-board-tag">archived</span>}
    </div>
    {!project.hasAgents && <p className="qd-empty">No live agents.</p>}
    {project.hasAgents && (
      <ul
        className="qd-board-agents"
        aria-label={agentsLabelOf({ project, isLabelled })}
      >
        {project.agents.map((agent) => (
          <AgentChip key={agent.id} agent={agent} />
        ))}
      </ul>
    )}
  </li>
);

const NOTHING_SHOWN: Record<WorkspaceMode, string> = {
  multi: 'Pick a project to watch.',
  single: 'No repository yet.',
};

const StreamLine = ({ stream }: { stream: StreamLiveness }) => (
  <p
    className="qd-status qd-board-stream"
    data-status={stream.status}
    title={stream.error}
  >
    {stream.label}
  </p>
);

export const BoardWidget = (): JSX.Element => {
  const view = useBoardWidget();
  const mode = useWorkspaceMode();
  const isMulti = mode === 'multi';
  const pause = {
    ...view.pause,
    outcomeText: wordingFor(mode)(view.pause.outcomeText),
  };
  return (
    <div className="qd-board">
      <VoyageControl />
      <section className="qd-board-liveness" aria-label="Liveness">
        <StreamLine stream={view.stream} />
        {!view.hasShownProjects && (
          <p className="qd-empty">{NOTHING_SHOWN[mode]}</p>
        )}
        {view.hasShownProjects && (
          <ul className="qd-board-projects">
            {view.projects.map((project) => (
              <ProjectStrip
                key={project.id}
                project={project}
                isLabelled={isMulti}
              />
            ))}
          </ul>
        )}
      </section>
      <PauseControls pause={pause} />
      {isMulti && <ProjectPicker picker={view.picker} />}
    </div>
  );
};

export default defineWidget({
  type: 'board',
  title: 'Board',
  component: BoardWidget,
  size: { w: 4, h: 12 },
  minSize: { w: 3, h: 4 },
});
