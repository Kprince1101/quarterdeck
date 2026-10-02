import { useMemo, useState } from 'react';
import type { IntentReply } from '../../api/index.js';
import { useDeck } from '../../deck/deck.js';
import { killAck } from './agent-actions.js';
import type { AgentView } from './agents-model.js';

export interface KillRequest {
  isKilling: boolean;
  failure: string | null;
  begin: () => void;
  accept: (reply: IntentReply) => void;
  cancel: () => void;
}

interface KillState {
  intentId: string | null;
  isAccepted: boolean;
}

const isAwaitingAck = (
  kill: KillState | null,
  agent: AgentView,
  isAcked: boolean,
): boolean => {
  if (kill === null || isAcked) return false;
  if (!kill.isAccepted || kill.intentId !== null) return true;
  return agent.isLive;
};

export const useKillRequest = (agent: AgentView): KillRequest => {
  const { events } = useDeck().stream;
  const [kill, setKill] = useState<KillState | null>(null);
  const intentId = kill?.intentId ?? null;
  const ack = useMemo(() => killAck(events, intentId), [events, intentId]);
  return {
    isKilling: isAwaitingAck(kill, agent, ack !== null),
    failure: ack?.failure ?? null,
    begin: () => {
      setKill({ intentId: null, isAccepted: false });
    },
    accept: (reply) => {
      setKill({ intentId: reply.id, isAccepted: true });
    },
    cancel: () => {
      setKill(null);
    },
  };
};
