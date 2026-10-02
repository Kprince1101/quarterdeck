import type { SessionUpdate, ToolCallStatus } from '@agentclientprotocol/sdk';
import type { RecordedUpdate } from './types.ts';

const sessionUpdates = (
  updates: readonly RecordedUpdate[],
  sessionId: string,
): SessionUpdate[] =>
  updates
    .filter((recorded) => recorded.sessionId === sessionId)
    .map((recorded) => recorded.update);

export const agentChunks = (
  updates: readonly RecordedUpdate[],
  sessionId: string,
): string[] =>
  sessionUpdates(updates, sessionId).flatMap((update) => {
    if (update.sessionUpdate !== 'agent_message_chunk') return [];
    if (update.content.type !== 'text') return [];
    return [update.content.text];
  });

export const agentText = (
  updates: readonly RecordedUpdate[],
  sessionId: string,
): string => agentChunks(updates, sessionId).join('');

export const toolCallUpdates = (
  updates: readonly RecordedUpdate[],
  sessionId: string,
  toolCallId: string,
): SessionUpdate[] =>
  sessionUpdates(updates, sessionId).filter(
    (update) =>
      (update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update') &&
      update.toolCallId === toolCallId,
  );

export const toolCallStatuses = (
  updates: readonly RecordedUpdate[],
  sessionId: string,
  toolCallId: string,
): ToolCallStatus[] =>
  toolCallUpdates(updates, sessionId, toolCallId).flatMap((update) => {
    if (
      update.sessionUpdate !== 'tool_call' &&
      update.sessionUpdate !== 'tool_call_update'
    ) {
      return [];
    }
    if (!update.status) return [];
    return [update.status];
  });
