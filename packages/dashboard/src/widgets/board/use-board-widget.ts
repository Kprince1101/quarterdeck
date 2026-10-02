import { useMemo } from 'react';
import type { StreamStatus } from '../../api/index.js';
import { useDeck } from '../../deck/deck.js';
import { STATUS_LABELS } from '../../shell/shell.js';
import { projectLiveness, type ProjectLiveness } from './board-model.js';
import { usePauseAll, type PauseAllView } from './use-pause-all.js';
import {
  useProjectPicker,
  type ProjectPickerView,
} from './use-project-picker.js';

export interface StreamLiveness {
  status: StreamStatus;
  label: string;
  error: string | undefined;
}

export interface BoardWidgetView {
  stream: StreamLiveness;
  picker: ProjectPickerView;
  pause: PauseAllView;
  projects: ProjectLiveness[];
  hasShownProjects: boolean;
}

export const useBoardWidget = (): BoardWidgetView => {
  const { stream, intents } = useDeck();
  const picker = useProjectPicker(stream.tables.projects);
  const pause = usePauseAll(intents);
  const projects = useMemo(
    () =>
      projectLiveness(
        stream.tables.projects,
        picker.shownIds,
        stream.tables.agents,
      ),
    [stream.tables.projects, stream.tables.agents, picker.shownIds],
  );

  return {
    stream: {
      status: stream.status,
      label: `Stream ${STATUS_LABELS[stream.status].toLowerCase()}`,
      error: stream.error ?? undefined,
    },
    picker,
    pause,
    projects,
    hasShownProjects: projects.length > 0,
  };
};
