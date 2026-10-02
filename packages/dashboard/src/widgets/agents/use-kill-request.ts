import { useMemo, useState } from 'react';
import type { IntentReply } from '../../api/index.js';
import { useDeck } from '../../deck/deck.js';
import { intentFailure } from './agent-actions.js';
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
}

export const useKillRequest = (agent: AgentView): KillRequest => {
  const { events } = useDeck().stream;
  const [kill, setKill] = useState<KillState | null>(null);
  const intentId = kill?.intentId ?? null;
  const failure = useMemo(
    () => intentFailure(events, intentId),
    [events, intentId],
  );
  return {
    isKilling: kill !== null && agent.isLive && failure === null,
    failure,
    begin: () => {
      setKill({ intentId: null });
    },
    accept: (reply) => {
      setKill({ intentId: reply.id });
    },
    cancel: () => {
      setKill(null);
    },
  };
};
