import { useState } from 'react';
import type { AttachmentUpload, IntentClient } from '../../api/index.js';
import { dataUrl } from '../../lib/base64.js';
import { withAttachments } from '../../primitives/index.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { PendingMessage, ProjectChoice } from './planner-model.js';

export interface PlannerChat {
  pending: PendingMessage[];
  isNewBusy: boolean;
  newError: string | null;
  hasNewError: boolean;
  handleSend: (text: string, attachments: AttachmentUpload[]) => Promise<void>;
  handleNew: () => void;
}

export const usePlannerChat = (
  project: ProjectChoice | null,
  intents: IntentClient,
): PlannerChat => {
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const fresh = useIntentRequest();

  const handleSend = async (
    text: string,
    attachments: AttachmentUpload[],
  ): Promise<void> => {
    if (project === null) return;
    const reply = await intents.planner.message(
      withAttachments({ project: project.slug, text }, attachments),
    );
    const intentId = reply.id;
    if (intentId === null) return;
    const previews = attachments.map(({ mimeType, data }) =>
      dataUrl(mimeType, data),
    );
    setPending((current) => [
      ...current,
      { projectId: project.id, intentId, text, previews },
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
