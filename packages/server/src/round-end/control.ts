import type { AgentLifecycle } from '../agents/index.js';
import { getErrorMessage } from '../lib/errors.js';
import type { Store, StoreEvent } from '../store/index.js';
import type { RoundCleanup } from './cleanup.js';
import {
  ENDED_REASON,
  endRound,
  endRoundWithoutDriver,
  killRound,
  type EndedRound,
} from './end.js';
import type { WrapUpOptions } from './wrap-up.js';

export const ROUND_INTENTS = {
  end: 'round.end',
  kill: 'round.kill',
} as const;

const ROUND_INTENT_KINDS: readonly string[] = Object.values(ROUND_INTENTS);

export interface RoundDriver {
  round: WrapUpOptions['round'];
  charter: string;
}

export interface RoundControlOptions {
  store: Store;
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  driver?: (roundId: string) => RoundDriver | undefined;
  onError?: (err: unknown) => void;
}

export interface RoundControl {
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

interface RoundIntent {
  id: string;
  kind: string;
  roundId: string;
}

type Settled =
  | { status: 'applied'; result: Record<string, unknown> }
  | { status: 'rejected'; result: { error: string } };

const reportRoundControlError = (err: unknown): void => {
  console.error('quarterdeck round control failed', err);
};

const pendingRoundIntents = async (store: Store): Promise<RoundIntent[]> => {
  const { rows } = await store.db.query<RoundIntent>(
    `select id, kind, input ->> 'roundId' as "roundId" from intents
     where project_id = $1 and status = 'pending' and kind = any($2::text[])
     order by created_at, id`,
    [store.projectId, ROUND_INTENT_KINDS],
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

const roundStatus = async (
  store: Store,
  roundId: string,
): Promise<string | undefined> => {
  const { rows } = await store.db.query<{ status: string }>(
    'select status from rounds where id = $1 and project_id = $2',
    [roundId, store.projectId],
  );
  return rows[0]?.status;
};

const refusal = async (
  store: Store,
  roundId: string,
): Promise<string | undefined> => {
  const status = await roundStatus(store, roundId);
  if (status === undefined) return `round ${roundId} not found`;
  if (status === 'ended') return `round ${roundId} has already ended`;
  return undefined;
};

const cleanupResult = (cleanup: RoundCleanup): Record<string, unknown> => ({
  roundId: cleanup.roundId,
  round: cleanup.round,
  ended: cleanup.ended,
  closedCards: cleanup.closedCards,
  retired: cleanup.retired,
  discardCards: cleanup.discardCards,
  reopened: cleanup.reopened,
});

const endedResult = (ended: EndedRound): Record<string, unknown> => ({
  ...cleanupResult(ended.cleanup),
  wrapUp: ended.wrapUp,
});

const startsAfter = (
  intent: RoundIntent,
  earlier: Promise<void>,
): Promise<void> => {
  if (intent.kind === ROUND_INTENTS.kill) return Promise.resolve();
  return earlier;
};

export const startRoundControl = async (
  options: RoundControlOptions,
): Promise<RoundControl> => {
  const { store, lifecycle } = options;
  const onError = options.onError ?? reportRoundControlError;
  const started = new Set<string>();
  const queues = new Map<string, Promise<void>>();
  const running = new Set<Promise<void>>();
  let scanning: Promise<void> | undefined;
  let again = false;
  let closing = false;

  const end = (roundId: string): Promise<EndedRound> => {
    const driver = options.driver?.(roundId);
    if (driver === undefined)
      return endRoundWithoutDriver({ store, lifecycle, roundId });
    return endRound({
      store,
      lifecycle,
      round: driver.round,
      charter: driver.charter,
      reason: ENDED_REASON,
    });
  };

  const apply = async (intent: RoundIntent): Promise<Settled> => {
    const refused = await refusal(store, intent.roundId);
    if (refused !== undefined)
      return { status: 'rejected', result: { error: refused } };
    if (intent.kind === ROUND_INTENTS.kill) {
      const cleanup = await killRound({
        store,
        lifecycle,
        roundId: intent.roundId,
      });
      return { status: 'applied', result: cleanupResult(cleanup) };
    }
    return {
      status: 'applied',
      result: endedResult(await end(intent.roundId)),
    };
  };

  const handle = async (intent: RoundIntent): Promise<void> => {
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

  const launch = (intent: RoundIntent): void => {
    started.add(intent.id);
    const { roundId } = intent;
    const before = queues.get(roundId) ?? Promise.resolve();
    const task = track(startsAfter(intent, before).then(() => handle(intent)));
    const last = Promise.all([before, task]).then(() => {
      if (queues.get(roundId) === last) queues.delete(roundId);
    });
    queues.set(roundId, last);
  };

  const scanOnce = async (): Promise<void> => {
    if (closing) return;
    for (const intent of await pendingRoundIntents(store)) {
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
    if (ROUND_INTENT_KINDS.includes(event.kind)) scan().catch(onError);
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
