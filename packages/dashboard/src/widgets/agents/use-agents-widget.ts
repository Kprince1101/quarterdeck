import { useMemo } from 'react';
import { useDeck } from '../../deck/DeckProvider.js';
import { useNow } from '../../lib/use-now.js';
import { buildAgents, type AgentsModel } from './agents-model.js';

export interface AgentsWidgetView extends AgentsModel {
  isEmpty: boolean;
}

export const useAgentsWidget = (): AgentsWidgetView => {
  const { tables, events } = useDeck().stream;
  const now = useNow();
  const model = useMemo(
    () => buildAgents(tables, events, now),
    [tables, events, now],
  );
  return { ...model, isEmpty: model.agents.length === 0 };
};
