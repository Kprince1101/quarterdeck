import { useDeck } from '../../deck/DeckProvider.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { ProjectPanel } from './project-model.js';

export interface PauseControlsView {
  isPending: boolean;
  error: string | null;
  handlePause: () => void;
  handleResume: () => void;
}

export const usePauseControls = (panel: ProjectPanel): PauseControlsView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  const setPaused = (paused: boolean) => {
    void run(() => intents.pause.set({ project: panel.slug, paused }));
  };
  return {
    isPending,
    error,
    handlePause: () => {
      setPaused(true);
    },
    handleResume: () => {
      setPaused(false);
    },
  };
};
