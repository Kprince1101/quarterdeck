import type { TurnRow } from '@quarterdeck/server/stream-schema';

export const NOW = Date.parse('2026-10-01T12:00:00.000Z');
export const HOUR = 60 * 60 * 1000;

export const AGENT = '00000000-0000-4000-8000-0000000000b1';
export const OTHER_AGENT = '00000000-0000-4000-8000-0000000000b2';

export const ago = (ms: number): string => new Date(NOW - ms).toISOString();

export const turn = (
  id: number,
  startedAt: string,
  inputTokens: number,
  outputTokens: number,
  agentId: string = AGENT,
): TurnRow => ({
  id,
  agentId,
  ticketId: null,
  seq: id,
  stopReason: 'end_turn',
  inputTokens,
  outputTokens,
  transcriptPath: null,
  startedAt,
  endedAt: startedAt,
});
