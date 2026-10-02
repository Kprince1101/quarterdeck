import { useMemo } from 'react';
import { useDeck } from '../../deck/DeckProvider.js';
import { conversation, type ConversationEntry } from './planner-model.js';
import { usePlannerChat, type PlannerChat } from './use-planner-chat.js';
import { useProjectPicker, type ProjectPicker } from './use-project-picker.js';

export interface PlannerWidgetView extends ProjectPicker, PlannerChat {
  projectValue: string;
  projectSlug: string;
  entries: ConversationEntry[];
  isEmpty: boolean;
  isChatDisabled: boolean;
  isNewDisabled: boolean;
}

export const usePlannerWidget = (): PlannerWidgetView => {
  const { stream, intents } = useDeck();
  const { events, tables } = stream;
  const picker = useProjectPicker(tables.projects);
  const chat = usePlannerChat(picker.project, intents);
  const projectId = picker.project?.id ?? '';
  const { pending } = chat;
  const entries = useMemo(
    () => conversation({ events, tickets: tables.tickets, pending, projectId }),
    [events, tables.tickets, pending, projectId],
  );
  return {
    ...picker,
    ...chat,
    projectValue: projectId,
    projectSlug: picker.project?.slug ?? '',
    entries,
    isEmpty: entries.length === 0,
    isChatDisabled: !picker.hasProject,
    isNewDisabled: !picker.hasProject || chat.isNewBusy,
  };
};
