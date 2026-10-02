import {
  lifecycleSchema,
  type BudgetWindow,
  type Lifecycle,
} from './schemas.js';

const smallerCap = (
  machine: number | null,
  repo: number | null,
): number | null => {
  if (machine === null) return repo;
  if (repo === null) return machine;
  return Math.min(machine, repo);
};

const tightenWindow = (
  machine: BudgetWindow,
  repo: BudgetWindow,
): BudgetWindow => ({
  hours: Math.max(machine.hours, repo.hours),
  capTokens: smallerCap(machine.capTokens, repo.capTokens),
  holdAtFraction: Math.min(machine.holdAtFraction, repo.holdAtFraction),
});

export const tightenRepoBudget = (
  machine: unknown,
  merged: unknown,
): unknown => {
  const result = lifecycleSchema.safeParse(merged);
  if (!result.success) return merged;
  const next: Lifecycle = result.data;
  return {
    ...next,
    budget: {
      ...next.budget,
      window: tightenWindow(
        (machine as Lifecycle).budget.window,
        next.budget.window,
      ),
    },
  };
};
