import type { UsageReadResult } from '@quarterdeck/server/intents';
import type { TurnRow } from '@quarterdeck/server/stream-schema';

export const AMBER_PERCENT = 60;
export const RED_PERCENT = 80;
export const NO_CAP = 'No cap set';
export const SCOPE = 'this project';

export type UsageLevel = 'ok' | 'amber' | 'red';

export interface UsageView {
  usedLabel: string;
  percentLabel: string | null;
  level: UsageLevel | null;
}

const TOKENS = new Intl.NumberFormat('en-US');

export const usageLevel = (percent: number): UsageLevel => {
  if (percent >= RED_PERCENT) return 'red';
  if (percent >= AMBER_PERCENT) return 'amber';
  return 'ok';
};

export const usageView = (read: UsageReadResult): UsageView => {
  const usedLabel = `${TOKENS.format(read.usedTokens)} tokens in the last ${read.windowHours}h, ${SCOPE}`;
  if (read.percent === null) {
    return { usedLabel, percentLabel: null, level: null };
  }
  return {
    usedLabel,
    percentLabel: `${Math.floor(read.percent)}%`,
    level: usageLevel(read.percent),
  };
};

export const lastTurnEnd = (turns: readonly TurnRow[]): string | null =>
  turns.reduce<string | null>((last, { endedAt }) => {
    if (endedAt === null || (last !== null && last >= endedAt)) return last;
    return endedAt;
  }, null);
