import { findAgent, type Agent } from '../agents/index.js';
import { LIFECYCLE_EVENTS } from '../lifecycle/index.js';
import { getErrorMessage } from '../lib/errors.js';
import { settleIntent, type SettledStatus } from '../planner/rows.js';
import { publishEvent, type Store, type StoreEvent } from '../store/index.js';

export const VOYAGE_START = 'voyage.start';
export const AGENT_MESSAGE = 'agent.message';

export const CREW_INTENT_KINDS: readonly string[] = [AGENT_MESSAGE];

export const NO_MESSAGES =
  'only the Driver and builders of a live voyage take messages';

export interface CrewIntent {
  id: string;
  kind: string;
  agentId: string | null;
  text: string | null;
}

export interface CrewIntentsOptions {
  store: Store;
  deliver: (agent: Agent, text: string) => Promise<boolean>;
  report: (err: unknown) => void;
  track: (task: Promise<void>) => void;
}

export interface CrewIntents {
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

const pendingCrewIntents = async (store: Store): Promise<CrewIntent[]> => {
  const { rows } = await store.db.query<CrewIntent>(
    `select id, kind, input ->> 'agentId' as "agentId", input ->> 'text' as text
     from intents
     where project_id = $1 and status = 'pending' and kind = any($2::text[])
     order by created_at, id`,
    [store.projectId, CREW_INTENT_KINDS],
  );
  return rows;
};

export const startCrewIntents = async (
  options: CrewIntentsOptions,
): Promise<CrewIntents> => {
  const { store } = options;
  const handled = new Set<string>();
  let running: Promise<void> | undefined;
  let again = false;
  let closing = false;

  const settle = (
    intent: CrewIntent,
    status: SettledStatus,
    result: Record<string, unknown>,
  ): Promise<void> =>
    store.db.transaction(async (tx) => {
      if (!(await settleIntent(tx, intent.id, status, result))) return;
      if (status === 'applied' || intent.agentId === null) return;
      await publishEvent(tx, store.projectId, {
        kind: LIFECYCLE_EVENTS.failed,
        agentId: intent.agentId,
        payload: { intentId: intent.id, intent: intent.kind, ...result },
      });
    });

  const message = async (intent: CrewIntent): Promise<void> => {
    try {
      const agent = await findAgent(store, intent.agentId ?? '');
      if (!(await options.deliver(agent, intent.text ?? ''))) {
        await settle(intent, 'rejected', { error: NO_MESSAGES });
        return;
      }
      await settle(intent, 'applied', { agentId: agent.id });
    } catch (err) {
      await settle(intent, 'rejected', { error: getErrorMessage(err) });
    }
  };

  const drainPending = async (): Promise<void> => {
    for (const intent of await pendingCrewIntents(store)) {
      if (closing) return;
      if (handled.has(intent.id)) continue;
      handled.add(intent.id);
      options.track(message(intent));
    }
  };

  const loop = async (): Promise<void> => {
    again = false;
    try {
      await drainPending();
    } finally {
      running = undefined;
    }
    if (again) return drain();
    return undefined;
  };

  const drain = (): Promise<void> => {
    again = true;
    running ??= loop();
    return running;
  };

  const onEvent = (event: StoreEvent): void => {
    if (CREW_INTENT_KINDS.includes(event.kind)) drain().catch(options.report);
  };

  const subscription = await store.subscribe(onEvent, {
    onError: options.report,
  });
  drain().catch(options.report);

  return {
    drain,
    close: async () => {
      closing = true;
      await subscription.close();
      await running?.catch(() => undefined);
    },
  };
};
