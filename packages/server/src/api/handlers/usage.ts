import { RulesError, loadRule, type BudgetWindow } from '@quarterdeck/rules';
import { readBudgetMeter } from '../../budget/index.js';
import type { UsageReadResult } from '../../intents/index.js';
import type { Store } from '../../store/index.js';
import type { ApiContext, IntentHandler } from '../context.js';
import { conflict } from '../http-error.js';
import { findRow, unrecorded } from '../record.js';

const repoDirOf = async (store: Store): Promise<string | undefined> => {
  const project = await findRow<{ repo_path: string | null }>(
    store.db,
    'select repo_path from projects where id = $1',
    [store.projectId],
    `project ${store.projectId} not found`,
  );
  return project.repo_path ?? undefined;
};

const budgetWindow = async (
  ctx: ApiContext,
  store: Store,
): Promise<BudgetWindow> => {
  const repoDir = await repoDirOf(store);
  try {
    const lifecycle = await loadRule('lifecycle', {
      homeDir: ctx.homeDir,
      ...(repoDir !== undefined && { repoDir }),
    });
    return lifecycle.budget.window;
  } catch (err) {
    if (err instanceof RulesError) throw conflict(err.message);
    throw err;
  }
};

const percentOf = (used: number, cap: number | null): number | null => {
  if (cap === null) return null;
  return (used / cap) * 100;
};

export const readUsage: IntentHandler<'usage.read'> = async (
  ctx,
  input,
  name,
) => {
  const store = await ctx.stores.get(input.project);
  const meter = await readBudgetMeter(
    store.db,
    store.projectId,
    await budgetWindow(ctx, store),
  );
  const read: UsageReadResult = {
    windowHours: meter.windowHours,
    usedTokens: meter.usedTokens,
    capTokens: meter.capTokens,
    percent: percentOf(meter.usedTokens, meter.capTokens),
  };
  return unrecorded(name, read);
};
