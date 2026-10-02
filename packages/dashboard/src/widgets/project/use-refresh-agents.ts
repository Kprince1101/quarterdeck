import { useDeck } from '../../deck/DeckProvider.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { ProjectPanel } from './project-model.js';

export interface RefreshAgentsView {
  refreshLabel: string;
  canRefresh: boolean;
  error: string | null;
  handleRefresh: () => void;
}

export const useRefreshAgents = (panel: ProjectPanel): RefreshAgentsView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  const { slug, idleAgentIds } = panel;
  const retireIdle = async () => {
    for (const agentId of idleAgentIds) {
      await intents.agent.retire({ project: slug, agentId });
    }
  };
  return {
    refreshLabel: `Refresh agents (${idleAgentIds.length})`,
    canRefresh: idleAgentIds.length > 0 && !isPending,
    error,
    handleRefresh: () => {
      void run(retireIdle);
    },
  };
};
