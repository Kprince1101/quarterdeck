import { useState, type ChangeEvent } from 'react';
import { useDeck } from '../deck/DeckProvider.js';
import { useNow } from '../lib/use-now.js';
import {
  DEFAULT_KEEP_AWAKE_CHOICE,
  KEEP_AWAKE_CHOICES,
  keepAwakeRequest,
  keepAwakeView,
  type KeepAwakeChoice,
  type KeepAwakeView,
} from './keep-awake-model.js';
import { useKeepAwakeSend } from './use-keep-awake-send.js';

export const KEEP_AWAKE_TICK_MS = 1000;

export interface KeepAwakeControlView extends KeepAwakeView {
  choice: string;
  choices: readonly KeepAwakeChoice[];
  error: string | null;
  hasError: boolean;
  handleToggle: () => void;
  handleChoose: (event: ChangeEvent<HTMLSelectElement>) => void;
}

export const useKeepAwake = (): KeepAwakeControlView => {
  const { stream, intents } = useDeck();
  const now = useNow(KEEP_AWAKE_TICK_MS);
  const [choice, setChoice] = useState(DEFAULT_KEEP_AWAKE_CHOICE);
  const { isSending, error, send } = useKeepAwakeSend();
  const view = keepAwakeView(stream.keepAwake, now);

  const start = (next: string): void => {
    send(() => intents.keepAwake.start(keepAwakeRequest(next)));
  };

  const handleToggle = (): void => {
    if (view.isOn) {
      send(() => intents.keepAwake.stop({}));
      return;
    }
    start(choice);
  };

  const handleChoose = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value;
    setChoice(next);
    if (view.isOn) start(next);
  };

  return {
    ...view,
    isDisabled: view.isDisabled || isSending,
    choice,
    choices: KEEP_AWAKE_CHOICES,
    error,
    hasError: error !== null,
    handleToggle,
    handleChoose,
  };
};
