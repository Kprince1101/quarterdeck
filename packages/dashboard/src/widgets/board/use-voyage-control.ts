import { useMemo, useState, type ChangeEvent } from 'react';
import type { IntentClient } from '../../api/index.js';
import { useDeck } from '../../deck/DeckProvider.js';
import { valueOf } from '../../grid/dom.js';
import { useConfirm } from '../project/use-confirm.js';
import { useIntentRequest, type IntentRequest } from '../use-intent-request.js';
import {
  globalVoyage,
  killAllLabel,
  type GlobalVoyage,
} from './voyage-model.js';

export interface VoyageProjectView {
  slug: string;
  killLabel: string;
  handleKill: () => void;
}

interface VoyageStartView {
  goal: string;
  canStart: boolean;
  handleGoalChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleStart: () => void;
}

interface VoyageStopView {
  isConfirmingKill: boolean;
  showVoyageActions: boolean;
  killConfirmLabel: string;
  handleEnd: () => void;
  handleKill: () => void;
  handleConfirmKill: () => void;
  handleCancelKill: () => void;
}

export interface VoyageControlView extends VoyageStartView, VoyageStopView {
  hasVoyage: boolean;
  noVoyage: boolean;
  voyageLabel: string;
  voyageGoal: string;
  projects: VoyageProjectView[];
  isPending: boolean;
  error: string | null;
}

const useVoyageStart = (
  intents: IntentClient,
  request: IntentRequest,
): VoyageStartView => {
  const [goal, setGoal] = useState('');
  return {
    goal,
    canStart: goal.trim() !== '' && !request.isPending,
    handleGoalChange: (event) => {
      setGoal(valueOf(event.currentTarget));
    },
    handleStart: () => {
      void request
        .run(() => intents.voyage.start({ goal }))
        .then((sent) => {
          if (sent) setGoal('');
        });
    },
  };
};

const useVoyageStop = (
  intents: IntentClient,
  request: IntentRequest,
  voyage: GlobalVoyage | null,
): VoyageStopView => {
  const kill = useConfirm();
  const send = (stop: (input: { voyage: number }) => Promise<unknown>) => {
    if (voyage === null) return;
    void request.run(() => stop({ voyage: voyage.number }));
  };
  return {
    isConfirmingKill: kill.isConfirming,
    showVoyageActions: kill.isAsking,
    killConfirmLabel: killAllLabel(voyage),
    handleEnd: () => {
      send(intents.voyage.end);
    },
    handleKill: kill.handleAsk,
    handleConfirmKill: () => {
      kill.settle();
      send(intents.voyage.kill);
    },
    handleCancelKill: kill.handleCancel,
  };
};

const useProjectKills = (
  intents: IntentClient,
  request: IntentRequest,
  voyage: GlobalVoyage | null,
): VoyageProjectView[] =>
  (voyage?.projects ?? []).map((slug) => ({
    slug,
    killLabel: `Kill ${slug}’s builders`,
    handleKill: () => {
      void request.run(() => intents.project.kill({ project: slug }));
    },
  }));

export const useVoyageControl = (): VoyageControlView => {
  const { stream, intents } = useDeck();
  const request = useIntentRequest();
  const voyage = useMemo(() => globalVoyage(stream.tables), [stream.tables]);
  const start = useVoyageStart(intents, request);
  const stop = useVoyageStop(intents, request, voyage);
  const projects = useProjectKills(intents, request, voyage);
  return {
    ...start,
    ...stop,
    hasVoyage: voyage !== null,
    noVoyage: voyage === null,
    voyageLabel: voyage?.label ?? '',
    voyageGoal: voyage?.goal ?? '',
    projects,
    isPending: request.isPending,
    error: request.error,
  };
};
