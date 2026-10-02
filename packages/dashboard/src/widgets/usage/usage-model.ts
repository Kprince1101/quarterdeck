import { RulesError, mergeLayer } from '@quarterdeck/rules/merge';
import { lifecycleSchema } from '@quarterdeck/rules/schemas';
import type { TurnRow } from '@quarterdeck/server/stream-schema';
import { z } from 'zod';
import type { RuleLayer, RulesView } from '../../api/index.js';
import { getErrorMessage } from '../../lib/errors.js';

export const WINDOW_HOURS = 5;
export const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;
export const AMBER_PERCENT = 60;
export const RED_PERCENT = 80;
export const NO_CAP = 'No cap set';

export type UsageLevel = 'ok' | 'amber' | 'red';

export interface UsageModel {
  tokens: number;
  tokensLabel: string;
  percent: number | null;
  percentLabel: string | null;
  level: UsageLevel | null;
}

const TOKENS = new Intl.NumberFormat('en-US');

export const windowTokens = (
  turns: readonly TurnRow[],
  now: number,
): number => {
  const since = now - WINDOW_MS;
  return turns
    .filter(({ startedAt }) => Date.parse(startedAt) >= since)
    .reduce((sum, turn) => sum + turn.inputTokens + turn.outputTokens, 0);
};

export const usageLevel = (percent: number): UsageLevel => {
  if (percent >= RED_PERCENT) return 'red';
  if (percent >= AMBER_PERCENT) return 'amber';
  return 'ok';
};

export const buildUsage = (
  turns: readonly TurnRow[],
  cap: number | null,
  now: number,
): UsageModel => {
  const tokens = windowTokens(turns, now);
  const tokensLabel = `${TOKENS.format(tokens)} tokens in the last ${WINDOW_HOURS}h`;
  if (cap === null) {
    return {
      tokens,
      tokensLabel,
      percent: null,
      percentLabel: null,
      level: null,
    };
  }
  const percent = (tokens / cap) * 100;
  return {
    tokens,
    tokensLabel,
    percent,
    percentLabel: `${Math.floor(percent)}%`,
    level: usageLevel(percent),
  };
};

const parseJson = (path: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new RulesError(path, getErrorMessage(err));
  }
};

const machineLayerOf = ({ path, content }: RuleLayer): unknown => {
  if (content === null) return {};
  return parseJson(path, content);
};

export const windowCapOf = (view: RulesView): number | null => {
  const rule = view.rules.find(({ name }) => name === 'lifecycle');
  if (rule === undefined) return null;
  const { defaults, machine } = rule;
  const merged = mergeLayer(
    parseJson(defaults.path, defaults.content),
    machineLayerOf(machine),
  );
  const result = lifecycleSchema.safeParse(merged);
  if (!result.success) {
    throw new RulesError(machine.path, z.prettifyError(result.error));
  }
  return result.data.usage?.windowCapTokens ?? null;
};
