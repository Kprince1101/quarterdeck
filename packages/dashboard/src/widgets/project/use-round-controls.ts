import { useState, type ChangeEvent } from 'react';
import { useDeck } from '../../deck/DeckProvider.js';
import { valueOf } from '../../grid/dom.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { ProjectPanel } from './project-model.js';
import { useConfirm } from './use-confirm.js';

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
  isConfirmingKill: boolean;
  showRoundActions: boolean;
  killConfirmLabel: string;
  handleGoalChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleStart: () => void;
  handleEnd: () => void;
  handleKill: () => void;
  handleConfirmKill: () => void;
  handleCancelKill: () => void;
}

const ticketCount = (count: number): string => {
  if (count === 1) return '1 ticket';
  return `${count} tickets`;
};

export const useRoundControls = (panel: ProjectPanel): RoundControlsView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  const kill = useConfirm();
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
    isConfirmingKill: kill.isConfirming,
    showRoundActions: kill.isAsking,
    killConfirmLabel: `Kill round? This reopens ${ticketCount(round?.reopenCount ?? 0)}`,
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
    handleKill: kill.handleAsk,
    handleConfirmKill: () => {
      kill.settle();
      sendForRound(intents.round.kill);
    },
    handleCancelKill: kill.handleCancel,
  };
};
