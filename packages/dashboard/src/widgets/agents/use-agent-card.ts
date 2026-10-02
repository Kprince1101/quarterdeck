import { useDeck } from '../../deck/deck.js';
import { useIntentRequest } from '../notebook/use-intent-request.js';
import {
  ACTION_LABELS,
  availableActions,
  sendAgentAction,
  type AgentActionKind,
} from './agent-actions.js';
import type { AgentView } from './agents-model.js';
import { useKillRequest } from './use-kill-request.js';

export const KILLING_LABEL = 'killing…';

export interface AgentActionView {
  kind: AgentActionKind;
  label: string;
  onClick: () => void;
}

export interface AgentCardView {
  stateLabel: string;
  isKilling: boolean;
  isBusy: boolean;
  error: string | null;
  actions: AgentActionView[];
}

const shownState = (agent: AgentView, isKilling: boolean): string => {
  if (isKilling) return KILLING_LABEL;
  return agent.stateLabel;
};

export const useAgentCard = (agent: AgentView): AgentCardView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  const kill = useKillRequest(agent);
  const target = { project: agent.project, agentId: agent.id };
  const handleKill = () => {
    kill.begin();
    void run(async () => {
      kill.accept(await sendAgentAction(intents, 'kill', target));
    }).then((sent) => {
      if (!sent) kill.cancel();
    });
  };
  const handlerOf = (kind: AgentActionKind) => {
    if (kind === 'kill') return handleKill;
    return () => {
      void run(() => sendAgentAction(intents, kind, target));
    };
  };
  return {
    stateLabel: shownState(agent, kill.isKilling),
    isKilling: kill.isKilling,
    isBusy: isPending || kill.isKilling,
    error: error ?? kill.failure,
    actions: availableActions(agent).map((kind) => ({
      kind,
      label: ACTION_LABELS[kind],
      onClick: handlerOf(kind),
    })),
  };
};
