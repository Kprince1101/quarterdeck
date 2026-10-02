import { GATE_EVENTS } from '../gate/index.js';
import type {
  Store,
  StoreEvent,
  Subscription,
  TableChange,
  WatchedTable,
  Watcher,
} from '../store/index.js';
import { isSettled, readSettleState } from './settle.js';

export const AUTO_END_EVENTS = {
  settling: 'round.settling',
  settled: 'round.settled',
} as const;

export type Scheduler = (ms: number, fire: () => void) => () => void;

export interface AutoEndOptions {
  store: Store;
  roundId: string;
  settleSeconds: number;
  end: (roundId: string) => Promise<void>;
  schedule?: Scheduler;
  onError?: (err: unknown) => void;
}

export interface AutoEnd {
  check: () => Promise<void>;
  close: () => Promise<void>;
}

const SETTLE_TABLES: ReadonlySet<WatchedTable> = new Set([
  'rounds',
  'tickets',
  'agents',
  'cards',
]);

export const timerScheduler: Scheduler = (ms, fire) => {
  const timer = setTimeout(fire, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

const reportAutoEndError = (err: unknown): void => {
  console.error('quarterdeck auto-end failed', err);
};

export const startAutoEnd = async (
  options: AutoEndOptions,
): Promise<AutoEnd> => {
  const { store, roundId, settleSeconds } = options;
  const schedule = options.schedule ?? timerScheduler;
  const report = options.onError ?? reportAutoEndError;
  let disarm: (() => void) | undefined;
  let closed = false;
  let ending = false;
  let tail: Promise<void> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const cancelTimer = (): void => {
    disarm?.();
    disarm = undefined;
  };

  const settled = async (): Promise<boolean> =>
    isSettled(await readSettleState(store.db, store.projectId, roundId));

  const fire = async (): Promise<boolean> => {
    disarm = undefined;
    if (closed || ending || !(await settled())) return false;
    ending = true;
    await store.publish({
      kind: AUTO_END_EVENTS.settled,
      payload: { roundId, settleSeconds },
    });
    return true;
  };

  const endIfDue = async (due: boolean): Promise<void> => {
    if (due) await options.end(roundId);
  };

  const arm = async (rearmed: boolean): Promise<void> => {
    disarm = schedule(settleSeconds * 1000, () => {
      serial(fire).then(endIfDue).catch(report);
    });
    await store.publish({
      kind: AUTO_END_EVENTS.settling,
      payload: { roundId, settleSeconds, rearmed },
    });
  };

  const evaluate = async (rearm: boolean): Promise<void> => {
    if (closed || ending) return;
    if (!(await settled())) {
      cancelTimer();
      return;
    }
    if (disarm !== undefined && !rearm) return;
    const rearmed = disarm !== undefined;
    cancelTimer();
    await arm(rearmed);
  };

  const check = (): Promise<void> => serial(() => evaluate(false));
  const rearm = (): Promise<void> => serial(() => evaluate(true));

  const onEvent = (event: StoreEvent): void => {
    if (event.kind === GATE_EVENTS.merged) rearm().catch(report);
  };
  const onChange = (change: TableChange): void => {
    if (SETTLE_TABLES.has(change.table)) check().catch(report);
  };

  const subscription: Subscription = await store.subscribe(onEvent, {
    onError: report,
  });
  let watcher: Watcher;
  try {
    watcher = await store.watch(onChange, { onError: report });
  } catch (err) {
    await subscription.close();
    throw err;
  }
  check().catch(report);

  let closing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    closed = true;
    cancelTimer();
    await Promise.allSettled([subscription.close(), watcher.close()]);
    await tail;
  };
  const close = (): Promise<void> => {
    closing ??= shutdown();
    return closing;
  };

  return { check, close };
};
