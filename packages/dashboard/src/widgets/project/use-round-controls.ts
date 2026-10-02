import { useState, type ChangeEvent } from 'react';
import { useDeck } from '../../deck/deck.js';
import { valueOf } from '../../grid/dom.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { ProjectPanel } from './project-model.js';

interface RoundTarget {
  project: string;
  roundId: string;
}

type RoundSender = (target: RoundTarget) => Promise<unknown>;

export interface RoundControlsView {
  hasRound: boolean;
  noRound: boolean;
  roundLabel: string;
  roundGoal: string;
  goal: string;
  canStart: boolean;
  isPending: boolean;
  error: string | null;
  handleGoalChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleStart: () => void;
  handleEnd: () => void;
  handleKill: () => void;
}

export const useRoundControls = (panel: ProjectPanel): RoundControlsView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  const [goal, setGoal] = useState('');
  const { round } = panel;
  const sendForRound = (send: RoundSender) => {
    if (round === null) return;
    void run(() => send({ project: panel.slug, roundId: round.id }));
  };
  return {
    hasRound: round !== null,
    noRound: round === null,
    roundLabel: round?.label ?? '',
    roundGoal: round?.goal ?? '',
    goal,
    canStart: goal.trim() !== '' && !isPending,
    isPending,
    error,
    handleGoalChange: (event) => {
      setGoal(valueOf(event.currentTarget));
    },
    handleStart: () => {
      void run(() => intents.round.start({ project: panel.slug, goal })).then(
        (sent) => {
          if (sent) setGoal('');
        },
      );
    },
    handleEnd: () => {
      sendForRound(intents.round.end);
    },
    handleKill: () => {
      sendForRound(intents.round.kill);
    },
  };
};
