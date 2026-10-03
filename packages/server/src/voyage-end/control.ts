import type { AgentLifecycle } from '../agents/index.js';
import { getErrorMessage } from '../lib/errors.js';
import type { Store, StoreEvent } from '../store/index.js';
import type { VoyageCleanup } from './cleanup.js';
import {
  ENDED_REASON,
  endVoyage,
  endVoyageWithoutDriver,
  killVoyage,
  type EndedVoyage,
} from './end.js';
import type { WrapUpOptions } from './wrap-up.js';

export const VOYAGE_INTENTS = {
  end: 'voyage.end',
  kill: 'voyage.kill',
} as const;

const VOYAGE_INTENT_KINDS: readonly string[] = Object.values(VOYAGE_INTENTS);

export interface VoyageDriver {
  voyage: WrapUpOptions['voyage'];
  charter: string;
}

export interface VoyageControlOptions {
  store: Store;
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  driver?: (voyageId: string) => VoyageDriver | undefined;
  onError?: (err: unknown) => void;
}

export interface VoyageControl {
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

interface VoyageIntent {
  id: string;
  kind: string;
  voyageId: string;
}

type Settled =
  | { status: 'applied'; result: Record<string, unknown> }
  | { status: 'rejected'; result: { error: string } };

const reportVoyageControlError = (err: unknown): void => {
  console.error('quarterdeck voyage control failed', err);
};

const pendingVoyageIntents = async (store: Store): Promise<VoyageIntent[]> => {
  const { rows } = await store.db.query<VoyageIntent>(
    `select id, kind, input ->> 'voyageId' as "voyageId" from intents
     where project_id = $1 and status = 'pending' and kind = any($2::text[])
     order by created_at, id`,
    [store.projectId, VOYAGE_INTENT_KINDS],
  );
  return rows;
};

const settle = async (
  store: Store,
  intentId: string,
  settled: Settled,
): Promise<void> => {
  await store.db.query(
    `update intents set status = $2, result = $3::jsonb, settled_at = now()
     where id = $1 and status = 'pending'`,
    [intentId, settled.status, JSON.stringify(settled.result)],
  );
};

const voyageStatus = async (
  store: Store,
  voyageId: string,
): Promise<string | undefined> => {
  const { rows } = await store.db.query<{ status: string }>(
    'select status from voyages where id = $1 and project_id = $2',
    [voyageId, store.projectId],
  );
  return rows[0]?.status;
};

const refusal = async (
  store: Store,
  voyageId: string,
): Promise<string | undefined> => {
  const status = await voyageStatus(store, voyageId);
  if (status === undefined) return `voyage ${voyageId} not found`;
  if (status === 'ended') return `voyage ${voyageId} has already ended`;
  return undefined;
};

const cleanupResult = (cleanup: VoyageCleanup): Record<string, unknown> => ({
  voyageId: cleanup.voyageId,
  voyage: cleanup.voyage,
  ended: cleanup.ended,
  closedCards: cleanup.closedCards,
  retired: cleanup.retired,
  discardCards: cleanup.discardCards,
  reopened: cleanup.reopened,
});

const endedResult = (ended: EndedVoyage): Record<string, unknown> => ({
  ...cleanupResult(ended.cleanup),
  wrapUp: ended.wrapUp,
});

const startsAfter = (
  intent: VoyageIntent,
  earlier: Promise<void>,
): Promise<void> => {
  if (intent.kind === VOYAGE_INTENTS.kill) return Promise.resolve();
  return earlier;
};

export const startVoyageControl = async (
  options: VoyageControlOptions,
): Promise<VoyageControl> => {
  const { store, lifecycle } = options;
  const onError = options.onError ?? reportVoyageControlError;
  const started = new Set<string>();
  const queues = new Map<string, Promise<void>>();
  const running = new Set<Promise<void>>();
  let scanning: Promise<void> | undefined;
  let again = false;
  let closing = false;

  const end = (voyageId: string): Promise<EndedVoyage> => {
    const driver = options.driver?.(voyageId);
    if (driver === undefined)
      return endVoyageWithoutDriver({ store, lifecycle, voyageId });
    return endVoyage({
      store,
      lifecycle,
      voyage: driver.voyage,
      charter: driver.charter,
      reason: ENDED_REASON,
    });
  };

  const apply = async (intent: VoyageIntent): Promise<Settled> => {
    const refused = await refusal(store, intent.voyageId);
    if (refused !== undefined)
      return { status: 'rejected', result: { error: refused } };
    if (intent.kind === VOYAGE_INTENTS.kill) {
      const cleanup = await killVoyage({
        store,
        lifecycle,
        voyageId: intent.voyageId,
      });
      return { status: 'applied', result: cleanupResult(cleanup) };
    }
    return {
      status: 'applied',
      result: endedResult(await end(intent.voyageId)),
    };
  };

  const handle = async (intent: VoyageIntent): Promise<void> => {
    let settled: Settled;
    try {
      settled = await apply(intent);
    } catch (err) {
      onError(err);
      settled = { status: 'rejected', result: { error: getErrorMessage(err) } };
    }
    await settle(store, intent.id, settled);
  };

  const track = (task: Promise<void>): Promise<void> => {
    const tracked = task.catch(onError).finally(() => {
      running.delete(tracked);
    });
    running.add(tracked);
    return tracked;
  };

  const launch = (intent: VoyageIntent): void => {
    started.add(intent.id);
    const { voyageId } = intent;
    const before = queues.get(voyageId) ?? Promise.resolve();
    const task = track(startsAfter(intent, before).then(() => handle(intent)));
    const last = Promise.all([before, task]).then(() => {
      if (queues.get(voyageId) === last) queues.delete(voyageId);
    });
    queues.set(voyageId, last);
  };

  const scanOnce = async (): Promise<void> => {
    if (closing) return;
    for (const intent of await pendingVoyageIntents(store)) {
      if (!started.has(intent.id)) launch(intent);
    }
  };

  const loop = async (): Promise<void> => {
    again = false;
    try {
      await scanOnce();
    } catch (err) {
      scanning = undefined;
      throw err;
    }
    if (again) return loop();
    scanning = undefined;
  };

  const scan = (): Promise<void> => {
    again = true;
    scanning ??= loop();
    return scanning;
  };

  const idle = async (): Promise<void> => {
    while (running.size > 0) await Promise.all(running);
  };

  const drain = async (): Promise<void> => {
    await scan();
    await idle();
  };

  const onEvent = (event: StoreEvent): void => {
    if (VOYAGE_INTENT_KINDS.includes(event.kind)) scan().catch(onError);
  };

  const subscription = await store.subscribe(onEvent, { onError });
  scan().catch(onError);

  const shutdown = async (): Promise<void> => {
    closing = true;
    await subscription.close();
    await scanning?.catch(() => undefined);
    await idle();
  };
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= shutdown();
    return closed;
  };

  return { drain, close };
};
