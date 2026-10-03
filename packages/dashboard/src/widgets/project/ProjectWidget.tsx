import type { JSX } from 'react';
import { defineWidget } from '../registry.js';
import { ArchiveControl } from './ArchiveControl.js';
import { CrewSummary } from './CrewSummary.js';
import type { ProjectOption } from './project-model.js';
import { ProjectToggles } from './ProjectToggles.js';
import { VoyageControls } from './VoyageControls.js';
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

export const ProjectWidget = (): JSX.Element => {
  const { options, chosenId, panel, handleProjectChange } = useProjectWidget();
  if (panel === null) return <p className="qd-empty">No projects yet.</p>;
  return (
    <div className="qd-project">
      <ProjectPicker
        value={chosenId}
        options={options}
        onChange={handleProjectChange}
      />
      <div className="qd-project-body" key={panel.id}>
        <VoyageControls panel={panel} />
        <ProjectToggles panel={panel} />
        <CrewSummary panel={panel} />
        <ArchiveControl panel={panel} />
      </div>
    </div>
  );
};

export default defineWidget({
  type: 'project',
  title: 'Project',
  component: ProjectWidget,
  size: { w: 4, h: 6 },
  minSize: { w: 3, h: 4 },
});
