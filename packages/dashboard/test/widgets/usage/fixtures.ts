import type { UsageReadResult } from '@quarterdeck/server/intents';
import type { ProjectRow, TurnRow } from '@quarterdeck/server/stream-schema';

export const NOW = Date.parse('2026-10-01T12:00:00.000Z');
export const AGENT = '00000000-0000-4000-8000-0000000000b1';
export const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

export const at = (minute: number): string =>
  new Date(NOW + minute * 60_000).toISOString();

export const project = (slug: string): ProjectRow => ({
  id: PROJECT_ID,
  slug,
  name: slug,
  repoPath: null,
  createdAt: at(-600),
  updatedAt: at(-600),
  archivedAt: null,
  pausedAt: null,
  tracker: null,
  publishes: null,
});

export const turn = (id: number, endedAt: string | null): TurnRow => ({
  id,
  agentId: AGENT,
  ticketId: null,
  seq: id,
  stopReason: 'end_turn',
  inputTokens: 10,
  outputTokens: 2,
  transcriptPath: null,
  startedAt: at(-60),
  endedAt,
});

export const usage = (
  usedTokens: number,
  capTokens: number | null,
): UsageReadResult => ({
  windowHours: 5,
  usedTokens,
  capTokens,
  percent: capTokens && (usedTokens / capTokens) * 100,
});
