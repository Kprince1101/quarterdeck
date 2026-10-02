import type { BudgetWindow, Lifecycle } from './schemas.js';

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

export const tightenRepoLifecycle = (
  machine: Lifecycle,
  merged: Lifecycle,
): Lifecycle => ({
  ...merged,
  budget: {
    ...merged.budget,
    window: tightenWindow(machine.budget.window, merged.budget.window),
  },
});
