import { useMemo, useState, type ChangeEvent } from 'react';
import { useDeck } from '../../deck/deck.js';
import { valueOf } from '../../grid/dom.js';
import { buildProject, type ProjectModel } from './project-model.js';

export type ProjectChangeHandler = (
  event: ChangeEvent<HTMLSelectElement>,
) => void;

export interface ProjectWidgetView extends ProjectModel {
  handleProjectChange: ProjectChangeHandler;
}

export const useProjectWidget = (): ProjectWidgetView => {
  const { tables } = useDeck().stream;
  const [chosenId, setChosenId] = useState('');
  const model = useMemo(
    () => buildProject(tables, chosenId),
    [tables, chosenId],
  );
  const handleProjectChange: ProjectChangeHandler = (event) => {
    setChosenId(valueOf(event.currentTarget));
  };
  return { ...model, handleProjectChange };
};
