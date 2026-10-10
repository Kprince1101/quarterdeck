import type { JSX } from 'react';
import type { WorkspaceMode } from '../../api/index.js';
import { useShowsProjects, useWorkspaceMode } from '../../deck/DeckProvider.js';
import { defineWidget } from '../registry.js';
import { ArchiveControl } from './ArchiveControl.js';
import { CrewSummary } from './CrewSummary.js';
import type { ProjectOption } from './project-model.js';
import { ProjectToggles } from './ProjectToggles.js';
import { ServicesSection } from './ServicesSection.js';
import {
  useProjectWidget,
  type ProjectChangeHandler,
} from './use-project-widget.js';
import './project.css';

interface ProjectPickerProps {
  value: string;
  options: ProjectOption[];
  onChange: ProjectChangeHandler;
}

const ProjectPicker = ({ value, options, onChange }: ProjectPickerProps) => (
  <label className="qd-project-picker">
    <span>Project</span>
    <select value={value} onChange={onChange}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

const EMPTY: Record<WorkspaceMode, string> = {
  multi: 'No projects yet.',
  single: 'No repository yet.',
};

export const ProjectWidget = (): JSX.Element => {
  const { options, chosenId, panel, handleProjectChange } = useProjectWidget();
  const mode = useWorkspaceMode();
  const showsProjects = useShowsProjects();
  if (panel === null) return <p className="qd-empty">{EMPTY[mode]}</p>;
  return (
    <div className="qd-project">
      {showsProjects && (
        <ProjectPicker
          value={chosenId}
          options={options}
          onChange={handleProjectChange}
        />
      )}
      <div className="qd-project-body" key={panel.id}>
        <ProjectToggles panel={panel} />
        <ServicesSection panel={panel} />
        <CrewSummary panel={panel} />
        <ArchiveControl panel={panel} />
      </div>
    </div>
  );
};

export default defineWidget({
  type: 'project',
  title: 'Project',
  singleTitle: 'Repository',
  component: ProjectWidget,
  size: { w: 4, h: 6 },
  minSize: { w: 3, h: 4 },
});
