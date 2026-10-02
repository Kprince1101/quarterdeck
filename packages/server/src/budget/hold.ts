import type { BudgetWindow } from '@quarterdeck/rules';
import {
  publishEvent,
  type PublishInput,
  type Queryable,
  type Store,
  type StoreEvent,
} from '../store/index.js';
import { BudgetHeldError } from './errors.js';
import { readBudgetMeter, type BudgetMeter } from './meter.js';

export const BUDGET_EVENTS = {
  held: 'budget.held',
  released: 'budget.released',
} as const;

export interface LaunchCheck {
  agentId?: string | undefined;
  ticketId?: string | undefined;
  now?: Date | undefined;
}

export type LaunchDecision =
  | { status: 'clear'; meter: BudgetMeter; released: StoreEvent | null }
  | { status: 'held'; meter: BudgetMeter; event: StoreEvent };

const meterPayload = (meter: BudgetMeter) => ({
  windowHours: meter.windowHours,
  usedTokens: meter.usedTokens,
  capTokens: meter.capTokens,
  holdAtTokens: meter.holdAtTokens,
  releaseAt: meter.releaseAt?.toISOString() ?? null,
});

const lockBudget = (tx: Queryable, projectId: string) =>
  tx.query(
    `select pg_advisory_xact_lock(hashtext('quarterdeck_budget'), hashtext($1))`,
    [projectId],
  );

const holding = async (tx: Queryable, projectId: string): Promise<boolean> => {
  const { rows } = await tx.query<{ kind: string }>(
    `select kind from events
     where project_id = $1 and kind in ($2, $3)
     order by id desc limit 1`,
    [projectId, BUDGET_EVENTS.held, BUDGET_EVENTS.released],
  );
  return rows[0]?.kind === BUDGET_EVENTS.held;
};

const launchEvent = (
  kind: string,
  meter: BudgetMeter,
  launch: LaunchCheck,
): PublishInput => {
  const event: PublishInput = { kind, payload: meterPayload(meter) };
  if (launch.agentId) event.agentId = launch.agentId;
  if (launch.ticketId) event.ticketId = launch.ticketId;
  return event;
};

export const checkLaunchBudget = (
  store: Pick<Store, 'db' | 'projectId'>,
  window: BudgetWindow,
  launch: LaunchCheck = {},
): Promise<LaunchDecision> =>
  store.db.transaction(async (tx) => {
    await lockBudget(tx, store.projectId);
    const meter = await readBudgetMeter(
      tx,
      store.projectId,
      window,
      launch.now,
    );
    if (meter.held) {
      const event = await publishEvent(
        tx,
        store.projectId,
        launchEvent(BUDGET_EVENTS.held, meter, launch),
      );
      return { status: 'held', meter, event };
    }
    if (!(await holding(tx, store.projectId))) {
      return { status: 'clear', meter, released: null };
    }
    const released = await publishEvent(tx, store.projectId, {
      kind: BUDGET_EVENTS.released,
      payload: meterPayload(meter),
    });
    return { status: 'clear', meter, released };
  });

export const assertLaunchBudget = async (
  store: Pick<Store, 'db' | 'projectId'>,
  window: BudgetWindow,
  launch: LaunchCheck = {},
): Promise<BudgetMeter> => {
  const decision = await checkLaunchBudget(store, window, launch);
  if (decision.status === 'held') throw new BudgetHeldError(decision.meter);
  return decision.meter;
};
