import { useState } from 'react';
import type { IntentClient } from '../../api/index.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { PendingMessage, ProjectChoice } from './planner-model.js';

export interface PlannerChat {
  pending: PendingMessage[];
  isNewBusy: boolean;
  newError: string | null;
  hasNewError: boolean;
  handleSend: (text: string) => Promise<void>;
  handleNew: () => void;
}

export const usePlannerChat = (
  project: ProjectChoice | null,
  intents: IntentClient,
): PlannerChat => {
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const fresh = useIntentRequest();

  const handleSend = async (text: string): Promise<void> => {
    if (project === null) return;
    const reply = await intents.planner.message({
      project: project.slug,
      text,
    });
    const intentId = reply.id;
    if (intentId === null) return;
    setPending((current) => [
      ...current,
      { projectId: project.id, intentId, text },
    ]);
  };

  const handleNew = (): void => {
    void fresh
      .run(() => intents.planner.new({}))
      .then((started) => {
        if (started) setPending([]);
      });
  };

  return {
    pending,
    isNewBusy: fresh.isPending,
    newError: fresh.error,
    hasNewError: fresh.error !== null,
    handleSend,
    handleNew,
  };
};
