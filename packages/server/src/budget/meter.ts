import type { BudgetWindow } from '@quarterdeck/rules';
import type { Queryable } from '../store/index.js';

const HOUR_MS = 3_600_000;

export interface BudgetMeter {
  windowHours: number;
  since: Date;
  usedTokens: number;
  capTokens: number | null;
  holdAtTokens: number | null;
  held: boolean;
  releaseAt: Date | null;
}

interface SpendRow {
  endedAt: Date;
  tokens: number | string;
}

const windowSpend = async (
  db: Queryable,
  projectId: string,
  since: Date,
): Promise<{ endedAt: Date; tokens: number }[]> => {
  const { rows } = await db.query<SpendRow>(
    `select t.ended_at as "endedAt",
            (t.input_tokens::int8 + t.output_tokens::int8) as tokens
     from turns t
     join agents a on a.id = t.agent_id
     where a.project_id = $1
       and t.ended_at > $2
       and t.input_tokens + t.output_tokens > 0
     order by t.ended_at, t.id`,
    [projectId, since],
  );
  return rows.map((row) => ({
    endedAt: new Date(row.endedAt),
    tokens: Number(row.tokens),
  }));
};

const releaseTime = (
  spend: readonly { endedAt: Date; tokens: number }[],
  used: number,
  holdAt: number,
  windowMs: number,
): Date | null => {
  let left = used;
  for (const { endedAt, tokens } of spend) {
    left -= tokens;
    if (left < holdAt) return new Date(endedAt.getTime() + windowMs);
  }
  return null;
};

export const readBudgetMeter = async (
  db: Queryable,
  projectId: string,
  window: BudgetWindow,
  now: Date = new Date(),
): Promise<BudgetMeter> => {
  const windowMs = window.hours * HOUR_MS;
  const since = new Date(now.getTime() - windowMs);
  const spend = await windowSpend(db, projectId, since);
  const usedTokens = spend.reduce((sum, { tokens }) => sum + tokens, 0);
  const meter: BudgetMeter = {
    windowHours: window.hours,
    since,
    usedTokens,
    capTokens: window.capTokens,
    holdAtTokens: null,
    held: false,
    releaseAt: null,
  };
  if (window.capTokens === null) return meter;
  const holdAtTokens = Math.ceil(window.capTokens * window.holdAtFraction);
  meter.holdAtTokens = holdAtTokens;
  if (usedTokens < holdAtTokens) return meter;
  meter.held = true;
  meter.releaseAt = releaseTime(spend, usedTokens, holdAtTokens, windowMs);
  return meter;
};
