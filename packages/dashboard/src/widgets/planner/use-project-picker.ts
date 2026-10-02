import type { ProjectRow } from '@quarterdeck/server/stream-schema';
import { useMemo, useState, type ChangeEvent } from 'react';
import { valueOf } from '../../grid/dom.js';
import {
  chosenProject,
  projectChoices,
  type ProjectChoice,
} from './planner-model.js';

export interface ProjectPicker {
  project: ProjectChoice | null;
  projectOptions: ProjectChoice[];
  hasProject: boolean;
  handleProjectChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}

export const useProjectPicker = (
  projects: readonly ProjectRow[],
): ProjectPicker => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const projectOptions = useMemo(() => projectChoices(projects), [projects]);
  const project = chosenProject(projectOptions, selectedId);
  return {
    project,
    projectOptions,
    hasProject: project !== null,
    handleProjectChange: (event) => {
      setSelectedId(valueOf(event.currentTarget));
    },
  };
};
