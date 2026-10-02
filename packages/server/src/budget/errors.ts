import type { BudgetMeter } from './meter.js';

export class BudgetHeldError extends Error {
  readonly meter: BudgetMeter;
  readonly releaseAt: Date | null;

  constructor(meter: BudgetMeter) {
    const releaseAt = meter.releaseAt?.toISOString() ?? 'unknown';
    super(
      `Launches are held: ${meter.usedTokens} tokens used in the last ${meter.windowHours}h, hold line ${meter.holdAtTokens}; under it at ${releaseAt}`,
    );
    this.name = 'BudgetHeldError';
    this.meter = meter;
    this.releaseAt = meter.releaseAt;
  }
}
