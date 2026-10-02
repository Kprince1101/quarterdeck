import type { AcpClientEvent } from '../acp/client/index.js';
import type { PlannerSession } from './sessions.js';

export interface ReplyCollector {
  text: () => string;
  stop: () => void;
}

const replyText = (
  event: AcpClientEvent,
  sessionId: string,
): string | undefined => {
  if (event.type !== 'session_update' || event.sessionId !== sessionId)
    return undefined;
  const { update } = event;
  if (update.sessionUpdate !== 'agent_message_chunk') return undefined;
  if (update.content.type !== 'text') return undefined;
  return update.content.text;
};

export const collectReply = (session: PlannerSession): ReplyCollector => {
  const chunks: string[] = [];
  const stop = session.client.subscribe((event) => {
    const text = replyText(event, session.sessionId);
    if (text !== undefined) chunks.push(text);
  });
  return { text: () => chunks.join(''), stop };
};
