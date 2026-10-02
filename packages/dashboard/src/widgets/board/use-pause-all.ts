import { useCallback, useState } from 'react';
import type { IntentClient, MachineState } from '../../api/index.js';
import {
  pauseFailure,
  pauseOutcome,
  type PauseOutcome,
  type PauseOutcomeTone,
} from './board-model.js';

export interface PauseAllView {
  isPending: boolean;
  isPausedEverywhere: boolean;
  pausedSince: string | undefined;
  showPauseAll: boolean;
  showResumeAll: boolean;
  hasOutcome: boolean;
  outcomeText: string;
  outcomeTone: PauseOutcomeTone | undefined;
  handlePauseAll: () => void;
  handleResumeAll: () => void;
}

export const usePauseAll = (
  intents: IntentClient,
  machine: MachineState,
): PauseAllView => {
  const [isPending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<PauseOutcome | null>(null);

  const send = useCallback(
    async (paused: boolean) => {
      setPending(true);
      setOutcome(null);
      try {
        const reply = await intents.pause.all({ paused });
        setOutcome(pauseOutcome(paused, reply.result));
      } catch (err) {
        setOutcome(pauseFailure(paused, err));
      } finally {
        setPending(false);
      }
    },
    [intents],
  );

  const handlePauseAll = useCallback(() => {
    void send(true);
  }, [send]);

  const handleResumeAll = useCallback(() => {
    void send(false);
  }, [send]);

  const isPausedEverywhere = machine.pausedAt !== null;

  return {
    isPending,
    isPausedEverywhere,
    pausedSince: machine.pausedAt ?? undefined,
    showPauseAll: !isPausedEverywhere,
    showResumeAll: isPausedEverywhere,
    hasOutcome: outcome !== null,
    outcomeText: outcome?.text ?? '',
    outcomeTone: outcome?.tone,
    handlePauseAll,
    handleResumeAll,
  };
};
