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
  settling: 'voyage.settling',
  settled: 'voyage.settled',
} as const;

export type Scheduler = (ms: number, fire: () => void) => () => void;

export interface AutoEndLeg {
  store: Store;
  voyageId: string;
}

export interface AutoEndOptions {
  legs: readonly AutoEndLeg[];
  settleSeconds: number;
  end: () => Promise<void>;
  schedule?: Scheduler;
  home?: string;
  onError?: (err: unknown) => void;
}

export interface AutoEnd {
  check: () => Promise<void>;
  close: () => Promise<void>;
}

const PAUSE_KINDS: readonly string[] = ['pause.set', 'pause.all'];

const SETTLE_TABLES: ReadonlySet<WatchedTable> = new Set([
  'voyages',
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
  const { legs, settleSeconds } = options;
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

  const legSettled = async ({ store, voyageId }: AutoEndLeg) =>
    isSettled(
      await readSettleState(store.db, store.projectId, voyageId, options.home),
    );

  const settled = async (): Promise<boolean> => {
    if (legs.length === 0) return false;
    const each = await Promise.all(legs.map(legSettled));
    return each.every(Boolean);
  };

  const publishAll = async (
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    for (const { store, voyageId } of legs)
      await store.publish({ kind, payload: { voyageId, ...payload } });
  };

  const fire = async (): Promise<boolean> => {
    disarm = undefined;
    if (closed || ending || !(await settled())) return false;
    ending = true;
    await publishAll(AUTO_END_EVENTS.settled, { settleSeconds });
    return true;
  };

  const endIfDue = async (due: boolean): Promise<void> => {
    if (due) await options.end();
  };

  const arm = async (rearmed: boolean): Promise<void> => {
    disarm = schedule(settleSeconds * 1000, () => {
      serial(fire).then(endIfDue).catch(report);
    });
    await publishAll(AUTO_END_EVENTS.settling, { settleSeconds, rearmed });
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
    if (PAUSE_KINDS.includes(event.kind)) check().catch(report);
  };
  const onChange = (change: TableChange): void => {
    if (SETTLE_TABLES.has(change.table)) check().catch(report);
  };

  const feeds: (Subscription | Watcher)[] = [];
  const closeFeeds = () =>
    Promise.allSettled(feeds.splice(0).map((feed) => feed.close()));
  try {
    for (const { store } of legs) {
      feeds.push(await store.subscribe(onEvent, { onError: report }));
      feeds.push(await store.watch(onChange, { onError: report }));
    }
  } catch (err) {
    await closeFeeds();
    throw err;
  }
  check().catch(report);

  let closing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    closed = true;
    cancelTimer();
    await closeFeeds();
    await tail;
  };
  const close = (): Promise<void> => {
    closing ??= shutdown();
    return closing;
  };

  return { check, close };
};
