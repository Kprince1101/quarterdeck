import type { StreamEvent } from '@quarterdeck/server/stream-schema';
import type { IntentClient, IntentReply } from '../../api/index.js';
import type { AgentView } from './agents-model.js';

export type AgentActionKind =
  'pause' | 'resume' | 'poke' | 'kill' | 'retire' | 'reset';

export interface AgentTarget {
  project: string;
  agentId: string;
}

export const POKE_TEXT =
  'Poke from the dashboard: say where you are and what is in your way, then carry on.';

export const INTENT_FAILED_KIND = 'agent.intent_failed';

export const KILLED_KIND = 'agent.killed';

export const UNEXPLAINED_FAILURE = 'The server could not apply it.';

export const ACTION_LABELS: Record<AgentActionKind, string> = {
  pause: 'Pause',
  resume: 'Resume',
  poke: 'Poke',
  kill: 'Kill',
  retire: 'Retire',
  reset: 'Reset',
};

type ActionSender = (
  intents: IntentClient,
  target: AgentTarget,
) => Promise<IntentReply>;

const SENDERS: Record<AgentActionKind, ActionSender> = {
  pause: (intents, target) => intents.agent.pause(target),
  resume: (intents, target) => intents.agent.resume(target),
  poke: (intents, target) =>
    intents.agent.message({ ...target, text: POKE_TEXT }),
  kill: (intents, target) => intents.agent.kill(target),
  retire: (intents, target) => intents.agent.retire(target),
  reset: (intents, target) => intents.agent.reset(target),
};

export const sendAgentAction = (
  intents: IntentClient,
  kind: AgentActionKind,
  target: AgentTarget,
): Promise<IntentReply> => SENDERS[kind](intents, target);

const pauseOrResume = (agent: AgentView): AgentActionKind => {
  if (agent.isPaused) return 'resume';
  return 'pause';
};

export const availableActions = (agent: AgentView): AgentActionKind[] => {
  if (!agent.isLive) return ['retire', 'reset'];
  return [pauseOrResume(agent), 'poke', 'kill', 'retire', 'reset'];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface KillAck {
  failure: string | null;
}

const failureOf = (payload: Record<string, unknown>): string => {
  const { error } = payload;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return UNEXPLAINED_FAILURE;
};

const killAckOf = (event: StreamEvent, intentId: string): KillAck | null => {
  const { payload } = event;
  if (!isRecord(payload) || payload['intentId'] !== intentId) return null;
  if (event.kind === KILLED_KIND) return { failure: null };
  if (event.kind === INTENT_FAILED_KIND) return { failure: failureOf(payload) };
  return null;
};

export const killAck = (
  events: readonly StreamEvent[],
  intentId: string | null,
): KillAck | null => {
  if (intentId === null) return null;
  for (const event of events) {
    const ack = killAckOf(event, intentId);
    if (ack !== null) return ack;
  }
  return null;
};
