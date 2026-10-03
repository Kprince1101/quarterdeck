import { useState, type ChangeEvent } from 'react';
import { useDeck } from '../../deck/DeckProvider.js';
import { valueOf } from '../../grid/dom.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { ProjectPanel } from './project-model.js';
import { useConfirm } from './use-confirm.js';

interface VoyageTarget {
  project: string;
  voyageId: string;
}

type VoyageSender = (target: VoyageTarget) => Promise<unknown>;

export interface VoyageControlsView {
  hasVoyage: boolean;
  noVoyage: boolean;
  voyageLabel: string;
  voyageGoal: string;
  goal: string;
  canStart: boolean;
  isPending: boolean;
  error: string | null;
  isConfirmingKill: boolean;
  showVoyageActions: boolean;
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

export const useVoyageControls = (panel: ProjectPanel): VoyageControlsView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  const kill = useConfirm();
  const [goal, setGoal] = useState('');
  const { voyage } = panel;
  const sendForVoyage = (send: VoyageSender) => {
    if (voyage === null) return;
    void run(() => send({ project: panel.slug, voyageId: voyage.id }));
  };
  return {
    hasVoyage: voyage !== null,
    noVoyage: voyage === null,
    voyageLabel: voyage?.label ?? '',
    voyageGoal: voyage?.goal ?? '',
    goal,
    canStart: goal.trim() !== '' && !isPending,
    isPending,
    error,
    isConfirmingKill: kill.isConfirming,
    showVoyageActions: kill.isAsking,
    killConfirmLabel: `Kill voyage? This reopens ${ticketCount(voyage?.reopenCount ?? 0)}`,
    handleGoalChange: (event) => {
      setGoal(valueOf(event.currentTarget));
    },
    handleStart: () => {
      void run(() => intents.voyage.start({ project: panel.slug, goal })).then(
        (sent) => {
          if (sent) setGoal('');
        },
      );
    },
    handleEnd: () => {
      sendForVoyage(intents.voyage.end);
    },
    handleKill: kill.handleAsk,
    handleConfirmKill: () => {
      kill.settle();
      sendForVoyage(intents.voyage.kill);
    },
    handleCancelKill: kill.handleCancel,
  };
};
