import { useMemo } from 'react';
import { useDeck } from '../../deck/deck.js';
import { useNow } from '../../lib/use-now.js';
import { buildAgents, type AgentsModel } from './agents-model.js';

export interface AgentsWidgetView extends AgentsModel {
  isEmpty: boolean;
}

export const useAgentsWidget = (): AgentsWidgetView => {
  const { tables } = useDeck().stream;
  const now = useNow();
  const model = useMemo(() => buildAgents(tables, now), [tables, now]);
  return { ...model, isEmpty: model.agents.length === 0 };
};
