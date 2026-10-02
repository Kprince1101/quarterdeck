import type { ProjectRow } from '@quarterdeck/server/stream-schema';
import { useCallback, useMemo, useState } from 'react';
import {
  BOARD_PROJECT_CAP,
  isArchived,
  listedProjects,
  shownProjectIds,
  togglePick,
} from './board-model.js';

export interface ProjectOption {
  id: string;
  name: string;
  isArchived: boolean;
  isPicked: boolean;
  isDisabled: boolean;
  handleToggle: () => void;
}

export interface ProjectPickerView {
  options: ProjectOption[];
  shownIds: string[];
  hasProjects: boolean;
  capLabel: string;
  showArchived: boolean;
  archivedLabel: string;
  handleToggleArchived: () => void;
}

export const useProjectPicker = (
  projects: readonly ProjectRow[],
): ProjectPickerView => {
  const [picked, setPicked] = useState<string[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const listed = useMemo(
    () => listedProjects(projects, showArchived),
    [projects, showArchived],
  );
  const shownIds = useMemo(
    () => shownProjectIds(listed, picked),
    [listed, picked],
  );

  const options = useMemo(() => {
    const isFull = shownIds.length >= BOARD_PROJECT_CAP;
    return listed.map((project) => {
      const isPicked = shownIds.includes(project.id);
      return {
        id: project.id,
        name: project.name,
        isArchived: isArchived(project),
        isPicked,
        isDisabled: isFull && !isPicked,
        handleToggle: () => {
          setPicked(togglePick(shownIds, project.id));
        },
      };
    });
  }, [listed, shownIds]);

  const handleToggleArchived = useCallback(() => {
    setShowArchived((shown) => !shown);
  }, []);

  const archivedCount = projects.filter(isArchived).length;

  return {
    options,
    shownIds,
    hasProjects: listed.length > 0,
    capLabel: `${shownIds.length} of ${BOARD_PROJECT_CAP} shown`,
    showArchived,
    archivedLabel: `Show archived (${archivedCount})`,
    handleToggleArchived,
  };
};
