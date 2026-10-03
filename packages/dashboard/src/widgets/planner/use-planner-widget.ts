import { useMemo } from 'react';
import { useDeck } from '../../deck/DeckProvider.js';
import {
  conversation,
  homeProject,
  projectChoices,
  projectLabels,
  type ConversationEntry,
  type ProjectChoice,
} from './planner-model.js';
import { usePlannerChat, type PlannerChat } from './use-planner-chat.js';

export interface PlannerWidgetView extends PlannerChat {
  homeSlug: string;
  projectOptions: ProjectChoice[];
  hasProject: boolean;
  entries: ConversationEntry[];
  isEmpty: boolean;
  isChatDisabled: boolean;
  isNewDisabled: boolean;
}

export const usePlannerWidget = (): PlannerWidgetView => {
  const { stream, intents } = useDeck();
  const { events, tables } = stream;
  const projectOptions = useMemo(
    () => projectChoices(tables.projects),
    [tables.projects],
  );
  const labels = useMemo(
    () => projectLabels(tables.projects),
    [tables.projects],
  );
  const home = homeProject(projectOptions);
  const chat = usePlannerChat(home, intents);
  const projectId = home?.id ?? '';
  const homeSlug = home?.slug ?? '';
  const { pending } = chat;
  const entries = useMemo(
    () =>
      conversation({
        events,
        tickets: tables.tickets,
        pending,
        projectId,
        homeSlug,
        labels,
      }),
    [events, tables.tickets, pending, projectId, homeSlug, labels],
  );
  return {
    ...chat,
    homeSlug,
    projectOptions,
    hasProject: home !== null,
    entries,
    isEmpty: entries.length === 0,
    isChatDisabled: home === null,
    isNewDisabled: chat.isNewBusy,
  };
};
